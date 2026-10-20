"use client";
import { useRef, useState } from "react";

const MODEL = "models/gemini-3.8-live";
const SYSTEM_INSTRUCTION = `
  You are Aanya, an intelligent and empathetic receptionist at Smile Care Dental Clinic.
  Speak in friendly, polite Hinglish, or English if the patient prefers.
  Help with clinic timings (10 AM to 8 PM), treatments (Root Canal, Cleaning, Whitening, Braces), and doctor consultation fee (₹500).
  For booking appointments, collect the patient's name, phone number, problem or treatment, and preferred date and time.
  Read all four details back and ask the patient to explicitly confirm before saving anything.
  After the patient confirms, call book_appointment exactly once with those details. Tell the patient the booking was saved only if the tool reports success. If saving fails, apologize and say the clinic needs to confirm manually.
  Keep replies brief, natural, and conversational.
`;

function encodePcm16(audioData, inputSampleRate) {
  const ratio = inputSampleRate / 16000;
  const outputLength = Math.floor(audioData.length / ratio);
  const pcmBytes = new Uint8Array(outputLength * 2);
  const dataView = new DataView(pcmBytes.buffer);

  for (let i = 0; i < outputLength; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(Math.floor((i + 1) * ratio), audioData.length);
    let sum = 0;
    for (let j = start; j < end; j += 1) sum += audioData[j];
    const sample = Math.max(-1, Math.min(1, sum / Math.max(1, end - start)));
    dataView.setInt16(i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }

  let binary = "";
  for (let i = 0; i < pcmBytes.length; i += 1) binary += String.fromCharCode(pcmBytes[i]);
  return btoa(binary);
}

export default function Home() {
  const [isConnected, setIsConnected] = useState(false);
  const [status, setStatus] = useState("Call disconnected. Click again to start.");
  const [isCalling, setIsCalling] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const socketRef = useRef(null);
  const mediaStreamRef = useRef(null);
  const audioContextRef = useRef(null);
  const outputAnalyserRef = useRef(null);
  const lipSyncFrameRef = useRef(null);
  const robotStageRef = useRef(null);
  const playbackSourcesRef = useRef(new Set());
  const microphoneNodesRef = useRef([]);
  const nextPlaybackTimeRef = useRef(0);
  const speakingTimeoutRef = useRef(null);
  const receptionPhoto = isConnected ? "/photo2.png" : "/photo1.png";

  const startLipSync = () => {
    const analyser = outputAnalyserRef.current;
    const stage = robotStageRef.current;
    if (!analyser || !stage || lipSyncFrameRef.current !== null) return;

    const samples = new Uint8Array(analyser.fftSize);
    const updateMouth = () => {
      if (outputAnalyserRef.current !== analyser || robotStageRef.current !== stage) {
        lipSyncFrameRef.current = null;
        return;
      }

      analyser.getByteTimeDomainData(samples);
      let energy = 0;
      for (const sample of samples) {
        const amplitude = (sample - 128) / 128;
        energy += amplitude * amplitude;
      }
      const volume = Math.sqrt(energy / samples.length);
      stage.style.setProperty("--mouth-open", String(Math.max(0.12, Math.min(1, volume * 5))));
      lipSyncFrameRef.current = requestAnimationFrame(updateMouth);
    };

    lipSyncFrameRef.current = requestAnimationFrame(updateMouth);
  };

  const clearSpeakingState = () => {
    if (speakingTimeoutRef.current) {
      clearTimeout(speakingTimeoutRef.current);
      speakingTimeoutRef.current = null;
    }
    if (lipSyncFrameRef.current !== null) {
      cancelAnimationFrame(lipSyncFrameRef.current);
      lipSyncFrameRef.current = null;
    }
    robotStageRef.current?.style.removeProperty("--mouth-open");
    setIsSpeaking(false);
  };

  const stopGeneratedAudio = () => {
    for (const source of playbackSourcesRef.current) source.stop();
    playbackSourcesRef.current.clear();
    nextPlaybackTimeRef.current = audioContextRef.current?.currentTime ?? 0;
    clearSpeakingState();
  };

  const releaseMedia = () => {
    microphoneNodesRef.current.forEach((node) => node.disconnect());
    microphoneNodesRef.current = [];
    outputAnalyserRef.current = null;

    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }

    if (audioContextRef.current) {
      const context = audioContextRef.current;
      audioContextRef.current = null;
      context.close().catch((error) => console.error("Could not close audio context:", error));
    }
  };

  const stopVoiceChat = () => {
    const socket = socketRef.current;
    socketRef.current = null;
    if (socket) {
      socket.onclose = null;
      socket.close();
    }

    stopGeneratedAudio();
    releaseMedia();

    setIsConnected(false);
    setIsCalling(false);
    setStatus("Call disconnected. Click again to start.");
  };

  const startVoiceChat = async () => {
    try {
      setIsCalling(true);
      setStatus("Connecting to Gemini AI...");

      const tokenResponse = await fetch("/api/session", { method: "POST" });
      const tokenData = await tokenResponse.json();
      if (!tokenResponse.ok || tokenData.error) {
        throw new Error(tokenData.error || "Could not create a Gemini Live session.");
      }
      if (typeof tokenData.token !== "string" || !tokenData.token) {
        throw new Error("Gemini did not return a temporary Live API token.");
      }

      const mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = mediaStream;
      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;
      nextPlaybackTimeRef.current = audioContext.currentTime;
      const outputAnalyser = audioContext.createAnalyser();
      outputAnalyser.fftSize = 256;
      outputAnalyser.connect(audioContext.destination);
      outputAnalyserRef.current = outputAnalyser;
      await audioContext.resume();

      const socket = new WebSocket(
        `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained?access_token=${encodeURIComponent(tokenData.token)}`
      );
      socketRef.current = socket;
      let configured = false;

      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Gemini connection timed out.")), 20000);

        socket.onopen = () => {
          socket.send(JSON.stringify({
            setup: {
              model: MODEL,
              generationConfig: {
                responseModalities: ["AUDIO"],
                speechConfig: {
                  voiceConfig: {
                    prebuiltVoiceConfig: { voiceName: "Aoede" },
                  },
                },
              },
              systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
              tools: [{
                functionDeclarations: [{
                  name: "book_appointment",
                  description: "Save a dental appointment only after the patient has explicitly confirmed the complete booking details.",
                  parameters: {
                    type: "OBJECT",
                    properties: {
                      patientName: { type: "STRING", description: "Patient's full name" },
                      phone: { type: "STRING", description: "Patient's contact phone number" },
                      treatment: { type: "STRING", description: "Dental issue or requested treatment" },
                      preferredDateTime: { type: "STRING", description: "Patient's preferred appointment date and time" },
                      confirmed: { type: "BOOLEAN", description: "True only after the patient explicitly confirms all booking details" },
                    },
                    required: ["patientName", "phone", "treatment", "preferredDateTime", "confirmed"],
                  },
                }],
              }],
            },
          }));
        };

        socket.onmessage = async (event) => {
          let message;
          try {
            const payload = event.data instanceof Blob
              ? await event.data.text()
              : event.data instanceof ArrayBuffer
                ? new TextDecoder().decode(event.data)
                : event.data;
            message = JSON.parse(payload);
          } catch (error) {
            clearTimeout(timeout);
            reject(new Error("Gemini returned a response that the app could not decode."));
            return;
          }

          if (message.error) {
            clearTimeout(timeout);
            reject(new Error(message.error.message || "Gemini Live connection failed."));
            return;
          }

          if (message.setupComplete && !configured) {
            configured = true;
            clearTimeout(timeout);

            const source = audioContext.createMediaStreamSource(mediaStream);
            const processor = audioContext.createScriptProcessor(4096, 1, 1);
            const mutedOutput = audioContext.createGain();
            mutedOutput.gain.value = 0;
            processor.onaudioprocess = (audioEvent) => {
              audioEvent.outputBuffer.getChannelData(0).fill(0);
              if (socket.readyState !== WebSocket.OPEN) return;
              const audio = encodePcm16(
                audioEvent.inputBuffer.getChannelData(0),
                audioContext.sampleRate
              );
              socket.send(JSON.stringify({
                realtimeInput: {
                  audio: { data: audio, mimeType: "audio/pcm;rate=16000" },
                },
              }));
            };
            source.connect(processor);
            processor.connect(mutedOutput);
            mutedOutput.connect(audioContext.destination);
            microphoneNodesRef.current = [source, processor, mutedOutput];
            setIsConnected(true);
            setIsCalling(false);
            setStatus("Connected to Gemini! Bolna shuru kijiye.");
            resolve();
          }

          if (message.serverContent?.interrupted) {
            stopGeneratedAudio();
          }

          if (message.toolCall?.functionCalls?.length) {
            const functionResponses = await Promise.all(
              message.toolCall.functionCalls.map(async (call) => {
                if (call.name !== "book_appointment") {
                  return {
                    id: call.id,
                    name: call.name,
                    response: { error: "Unsupported appointment action." },
                  };
                }

                try {
                  const saveResponse = await fetch("/api/appointments", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(call.args),
                  });
                  const saveResult = await saveResponse.json();
                  if (!saveResponse.ok) {
                    throw new Error(saveResult.error || "Booking could not be saved.");
                  }

                  setStatus("Appointment saved to Google Sheets.");
                  return {
                    id: call.id,
                    name: call.name,
                    response: { result: "Appointment saved successfully." },
                  };
                } catch (error) {
                  console.error("Appointment save failed:", error);
                  const saveError = error instanceof Error
                    ? error.message
                    : "Unknown Google Sheets error.";
                  setStatus(`Booking not saved: ${saveError}`);
                  return {
                    id: call.id,
                    name: call.name,
                    response: {
                      error: `The booking was not saved (${saveError}). Tell the patient the clinic must confirm it manually.`,
                    },
                  };
                }
              })
            );
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({
                toolResponse: { functionResponses },
              }));
            }
          }

          const parts = message.serverContent?.modelTurn?.parts || [];
          for (const part of parts) {
            if (!part.inlineData?.data) continue;
            const binary = atob(part.inlineData.data);
            const pcm = new DataView(
              Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer
            );
            const sampleCount = Math.floor(pcm.byteLength / 2);
            const sampleRate = Number(part.inlineData.mimeType?.match(/rate=(\d+)/)?.[1]) || 24000;
            const audioBuffer = audioContext.createBuffer(1, sampleCount, sampleRate);
            const channel = audioBuffer.getChannelData(0);
            for (let i = 0; i < sampleCount; i += 1) {
              channel[i] = pcm.getInt16(i * 2, true) / 32768;
            }
            const playback = audioContext.createBufferSource();
            playback.buffer = audioBuffer;
            playback.connect(outputAnalyser);
            playback.onended = () => playbackSourcesRef.current.delete(playback);
            const startAt = Math.max(audioContext.currentTime, nextPlaybackTimeRef.current);
            playbackSourcesRef.current.add(playback);
            playback.start(startAt);
            nextPlaybackTimeRef.current = startAt + audioBuffer.duration;
            setIsSpeaking(true);
            startLipSync();
            if (speakingTimeoutRef.current) clearTimeout(speakingTimeoutRef.current);
            speakingTimeoutRef.current = setTimeout(() => {
              speakingTimeoutRef.current = null;
              if (lipSyncFrameRef.current !== null) {
                cancelAnimationFrame(lipSyncFrameRef.current);
                lipSyncFrameRef.current = null;
              }
              robotStageRef.current?.style.removeProperty("--mouth-open");
              setIsSpeaking(false);
            }, Math.max(0, (nextPlaybackTimeRef.current - audioContext.currentTime) * 1000));
          }
        };

        socket.onerror = () => {
          clearTimeout(timeout);
          reject(new Error("Could not connect to Gemini Live. Check the network and API access."));
        };

        socket.onclose = (event) => {
          clearTimeout(timeout);
          if (!configured) {
            reject(new Error(event.reason || `Gemini closed the connection (${event.code}).`));
          } else if (socketRef.current === socket) {
            socketRef.current = null;
            stopGeneratedAudio();
            releaseMedia();
            setIsConnected(false);
            setIsCalling(false);
            setStatus("Gemini connection closed. Click to try again.");
          }
        };
      });
    } catch (error) {
      stopVoiceChat();
      setStatus(`Connection error: ${error.message}`);
    }
  };

  return (
    <main className="receptionist-app">
      <div className="app-orb app-orb-one" aria-hidden="true" />
      <div className="app-orb app-orb-two" aria-hidden="true" />

      <header className="topbar">
        <a className="brand" href="/" aria-label="Smile Care Dental home">
          <span className="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 32 32" fill="none">
              <path d="M16 27C12 24.8 5.2 18.7 5.2 11.5A6.3 6.3 0 0 1 16 7.1a6.3 6.3 0 0 1 10.8 4.4C26.8 18.7 20 24.8 16 27Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
              <path d="M8 15h4l2-4 3.2 9 2.1-5H24" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <span className="brand-copy">
            <span className="brand-name">Smile Care</span>
            <span className="brand-subtitle">Dental Clinic</span>
          </span>
        </a>

        <nav className="main-navigation" aria-label="Main navigation">
          <a href="#services">Treatments <span aria-hidden="true">⌄</span></a>
          <a href="#clinic-hours">Clinic Hours</a>
          <a href="#about">About</a>
        </nav>

        <div className="header-actions">
          <a href="#patient-portal" className="login-link">Login</a>
          <a href="#call-assistant" className="book-now-link">Book Now</a>
        </div>
      </header>

      <section className="receptionist-card" id="about" aria-labelledby="page-title">
        <div className="hero-copy">
          <a className="brand hero-brand" href="/" aria-label="Smile Care Dental home">
            <span className="brand-mark" aria-hidden="true">
              <svg viewBox="0 0 32 32" fill="none">
                <path d="M16 3.5c-3.3-2.1-8.2-1.2-10 2.2-2.2 4 .1 10.4 1.6 14.4 1.2 3.1 2.1 8.3 4.4 8.4 2.1.1 2.1-7.1 4-7.1s1.9 7.2 4 7.1c2.3-.1 3.2-5.3 4.4-8.4 1.5-4 3.8-10.4 1.6-14.4-1.8-3.4-6.7-4.3-10-2.2Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
                <path d="M7.3 11.2c2.5-.3 4.3.3 5.6 1.8m11.8-1.8c-2.5-.3-4.3.3-5.6 1.8" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" opacity=".8" />
              </svg>
            </span>
            <span className="brand-copy">
              <span className="brand-name">Smile Care</span>
              <span className="brand-subtitle">Dental Clinic</span>
            </span>
          </a>

          <h1 id="page-title">
            Meet your
            <span>AI receptionist.</span>
          </h1>
          <p className="hero-description">
            A little help for a healthier smile. Ask about treatments, clinic
            hours, or book your next visit with Aanya.
          </p>

          <div id="call-assistant" className={`assistant-status ${isConnected ? "is-connected" : ""}`} aria-live="polite">
            <span className="status-indicator" aria-hidden="true">
              <span />
            </span>
            <div className="status-copy">
              <span className="status-label">{isCalling ? "CONNECTING" : isConnected ? "YOU'RE CONNECTED" : "READY WHEN YOU ARE"}</span>
              <span className="status-message">{status}</span>
            </div>
            {isConnected && (
              <div className="voice-bars" aria-hidden="true">
                <i /><i /><i /><i /><i />
              </div>
            )}
          </div>

          {!isConnected ? (
            <button
              onClick={startVoiceChat}
              disabled={isCalling}
              className="call-button"
            >
              <span className="call-button-icon" aria-hidden="true">
                {isCalling ? (
                  <span className="connecting-spinner" />
                ) : (
                  <svg viewBox="0 0 24 24" fill="none">
                    <path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Z" stroke="currentColor" strokeWidth="1.8" />
                    <path d="M6.5 11.5a5.5 5.5 0 0 0 11 0M12 17v3m-3 0h6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                  </svg>
                )}
              </span>
              <span>{isCalling ? "Connecting to Aanya..." : "Talk with Aanya"}</span>
              {!isCalling && <span className="button-arrow" aria-hidden="true">→</span>}
            </button>
          ) : (
            <button onClick={stopVoiceChat} className="call-button end-call-button">
              <span className="call-button-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none">
                  <path d="M5.2 14.2c4.2-3.2 9.4-3.2 13.6 0l1.1.8a1.7 1.7 0 0 1 .5 2.2l-.9 1.6a1.7 1.7 0 0 1-2 .8l-2.1-.7a1.7 1.7 0 0 1-1.2-1.6v-.7a11 11 0 0 0-4.4 0v.7a1.7 1.7 0 0 1-1.2 1.6l-2.1.7a1.7 1.7 0 0 1-2-.8l-.9-1.6a1.7 1.7 0 0 1 .5-2.2l1.1-.8Z" fill="currentColor" />
                </svg>
              </span>
              <span>End conversation</span>
            </button>
          )}
          <p className="privacy-note">
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M4.5 7V5a3.5 3.5 0 0 1 7 0v2M3.5 7h9v7h-9V7Z" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Your conversation is private and secure
          </p>
        </div>

        <div
          ref={robotStageRef}
          className={`robot-stage photo-ready ${isConnected ? "robot-is-listening" : ""} ${isSpeaking ? "robot-is-speaking" : ""}`}
          role="img"
          aria-label={isConnected
            ? "Aanya, a dental receptionist at her desk, answering a phone call"
            : "Aanya, a dental receptionist at her desk, ready to help"}
        >
          <img
            key={receptionPhoto}
            className="reception-photo"
            src={receptionPhoto}
            alt={isConnected
              ? "Aanya, Smile Care's receptionist, answering a call"
              : "Aanya, Smile Care's receptionist, ready at her desk"}
          />
          <svg className={`photo-lipsync ${isSpeaking ? "photo-lipsync-active" : ""}`} viewBox="0 0 1030 700" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
            <ellipse className="photo-mouth-shadow" cx="516" cy="236" rx="15" ry="2" />
            <path className="photo-mouth-opening" d="M501 234 Q516 232 531 234 Q529 244 516 245 Q503 244 501 234Z" />
            <path className="photo-mouth-teeth" d="M505 235 Q516 233 527 235 L526 238 L506 238Z" />
          </svg>
          <svg className="reception-scene" viewBox="0 0 840 620" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
            <defs>
              <linearGradient id="scene-wall" x1="0" y1="0" x2="1" y2="1">
                <stop stopColor="#132c3a" />
                <stop offset=".52" stopColor="#204757" />
                <stop offset="1" stopColor="#101f2c" />
              </linearGradient>
              <linearGradient id="window-glass" x1="0" y1="0" x2="1" y2="1">
                <stop stopColor="#8fe9f2" stopOpacity=".34" />
                <stop offset=".5" stopColor="#a9e8f1" stopOpacity=".08" />
                <stop offset="1" stopColor="#38a9c7" stopOpacity=".24" />
              </linearGradient>
              <linearGradient id="shell" x1="0" y1="0" x2="1" y2=".4">
                <stop stopColor="#829da7" />
                <stop offset=".19" stopColor="#f4f7ee" />
                <stop offset=".48" stopColor="#dce7e4" />
                <stop offset=".73" stopColor="#fffef3" />
                <stop offset="1" stopColor="#8eaab2" />
              </linearGradient>
              <linearGradient id="face-shell" x1="0" y1="0" x2="1" y2="1">
                <stop stopColor="#e8ece3" />
                <stop offset=".45" stopColor="#fffdf0" />
                <stop offset="1" stopColor="#99b1b4" />
              </linearGradient>
              <linearGradient id="dark-metal" x1="0" y1="0" x2="1" y2="1">
                <stop stopColor="#101a28" />
                <stop offset=".48" stopColor="#30485a" />
                <stop offset="1" stopColor="#0a1725" />
              </linearGradient>
              <linearGradient id="desk-top" x1="0" y1="0" x2="0" y2="1">
                <stop stopColor="#d5b78d" />
                <stop offset=".2" stopColor="#765b47" />
                <stop offset=".27" stopColor="#d7b98a" />
                <stop offset="1" stopColor="#785b43" />
              </linearGradient>
              <radialGradient id="temple-glow">
                <stop stopColor="#43dcff" stopOpacity=".95" />
                <stop offset=".42" stopColor="#147ed0" stopOpacity=".72" />
                <stop offset="1" stopColor="#082b55" stopOpacity=".15" />
              </radialGradient>
              <filter id="soft-shadow" x="-.3" y="-.3" width="1.6" height="1.7">
                <feGaussianBlur in="SourceAlpha" stdDeviation="10" />
                <feOffset dy="10" />
                <feComponentTransfer><feFuncA type="linear" slope=".34" /></feComponentTransfer>
                <feMerge><feMergeNode /><feMergeNode in="SourceGraphic" /></feMerge>
              </filter>
              <filter id="blue-glow" x="-.8" y="-.8" width="2.6" height="2.6">
                <feGaussianBlur stdDeviation="5" result="blur" />
                <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
              </filter>
              <pattern id="circuit-lines" width="18" height="18" patternUnits="userSpaceOnUse">
                <path d="M3 0v7h5v6h7M0 15h5v-4" fill="none" stroke="#32b8ec" strokeOpacity=".45" strokeWidth="1" />
                <circle cx="15" cy="13" r="1.4" fill="#75e5ff" />
              </pattern>
            </defs>

            <rect width="840" height="620" fill="url(#scene-wall)" />
            <path d="M0 0h840v74H0z" fill="#0d1b27" />
            <path d="M30 71h345M408 71h175M625 71h190" stroke="#d9f4ed" strokeOpacity=".8" strokeWidth="5" />
            <path d="M30 76h345M408 76h175M625 76h190" stroke="#49d9f3" strokeOpacity=".56" strokeWidth="2" filter="url(#blue-glow)" />

            <g opacity=".9">
              <path d="M545 82h295v365H545z" fill="url(#window-glass)" stroke="#78c8d5" strokeOpacity=".5" strokeWidth="3" />
              <path d="M616 82v365M692 82v365M768 82v365M545 204h295M545 323h295" stroke="#b5eff4" strokeOpacity=".33" strokeWidth="2" />
              <path d="M553 95h7v320h-7zM577 95h3v320h-3zM803 95h5v320h-5z" fill="#a0e8f5" opacity=".4" />
              <path d="M545 423h295" stroke="#51d5ed" strokeOpacity=".65" strokeWidth="4" />
              <path d="M558 435v-165h270v165" fill="#102d3d" fillOpacity=".24" />
            </g>

            <g opacity=".88">
              <rect x="30" y="127" width="124" height="191" rx="5" fill="#0c1c28" stroke="#49aac2" strokeOpacity=".55" strokeWidth="3" />
              <rect x="39" y="137" width="106" height="80" rx="3" fill="#12647c" />
              <text x="58" y="190" fill="#b7f5ff" fontFamily="Arial, sans-serif" fontSize="42" fontWeight="700">AI</text>
              <rect x="39" y="229" width="106" height="78" rx="3" fill="#102c3a" />
              <path d="M50 248h76M50 261h63M50 276h81M50 290h50" stroke="#58d7ec" strokeOpacity=".75" strokeWidth="3" />
              <path d="M21 322h151v17H21z" fill="#a9bbc0" />
            </g>

            <g opacity=".64">
              <path d="M83 275h154v115H83z" fill="#091620" stroke="#547480" strokeWidth="7" />
              <rect x="91" y="283" width="138" height="95" fill="#13566b" />
              <path d="M102 300h79M102 315h105M102 330h83M102 350h110" stroke="#63dbee" strokeOpacity=".75" strokeWidth="4" />
              <path d="M168 390v49m-38 0h76" stroke="#647780" strokeWidth="8" />
              <path d="M78 441h102l-13 18H92z" fill="#34444c" />
              <circle cx="58" cy="271" r="18" fill="#ba7d62" />
              <path d="M39 270q7-34 37-15l-3 18-30 3Z" fill="#31292b" />
              <path d="M44 292q15-13 30 0l16 55-67 4z" fill="#c6d3cf" />
            </g>

            <g opacity=".52">
              <path d="M626 276h135v98H626z" fill="#0a1a26" stroke="#547480" strokeWidth="6" />
              <rect x="633" y="283" width="121" height="80" fill="#10516a" />
              <path d="M645 299h69M645 315h94M645 332h78M645 347h98" stroke="#64d9ec" strokeOpacity=".76" strokeWidth="3" />
              <path d="M691 374v47m-35 0h70" stroke="#60727b" strokeWidth="7" />
              <circle cx="592" cy="269" r="16" fill="#c08d72" />
              <path d="M577 268q7-30 34-14l2 16-34 1Z" fill="#372f31" />
              <path d="M575 290q17-13 34 0l22 55h-76z" fill="#aabdc0" />
            </g>

            <path d="M0 395 185 350h491l164 45v112H0z" fill="#23343d" opacity=".65" />
            <path d="M0 445h840v175H0z" fill="url(#desk-top)" />
            <path d="M0 447h840" stroke="#f5d9aa" strokeOpacity=".82" strokeWidth="5" />
            <path d="M0 461h840" stroke="#382e2a" strokeOpacity=".5" strokeWidth="4" />
            <path d="M0 611h840" stroke="#57d7e8" strokeOpacity=".8" strokeWidth="5" filter="url(#blue-glow)" />

            <ellipse cx="411" cy="455" rx="207" ry="26" fill="#09151d" opacity=".55" />

            <g filter="url(#soft-shadow)">
              <path d="M307 183q-2-47 29-70l26-31 76 7q29 22 22 80l-12 54-124 3z" fill="url(#dark-metal)" stroke="#627b85" strokeWidth="3" />
              <path d="M315 119q-15-34 16-61l51-21q43 3 57 38l-13 41-63 37z" fill="#071522" stroke="#24608b" strokeWidth="4" />
              <path d="M320 107q18-38 63-53M325 121q23-35 62-47M335 130q24-28 55-38" fill="none" stroke="#27a8f0" strokeOpacity=".82" strokeWidth="3" />
              <circle cx="340" cy="101" r="30" fill="#0b2032" stroke="#1d88d4" strokeWidth="5" />
              <circle cx="340" cy="101" r="22" fill="url(#temple-glow)" stroke="#60dfff" strokeWidth="2" filter="url(#blue-glow)" />
              <circle cx="340" cy="101" r="13" fill="none" stroke="#78e9ff" strokeWidth="2" />
              <circle cx="340" cy="101" r="5" fill="#b9f8ff" />

              <path d="M361 57q27-20 58-2 25 19 20 51l-8 43q-8 35-36 48l-24-7q-20-14-26-42l-7-48q-3-27 23-43Z" fill="url(#face-shell)" stroke="#fff9e7" strokeWidth="3" />
              <path d="M411 64q24 11 21 41l-8 45q-7 29-31 44 25-4 37-31l11-53q3-34-22-49Z" fill="#81999f" opacity=".62" />
              <path d="M383 107q10-8 21 0" fill="none" stroke="#324b58" strokeWidth="4" strokeLinecap="round" />
              <ellipse cx="395" cy="109" rx="3.4" ry="4.6" fill="#45c9ec" />
              <path d="M414 106q8-5 15 1" fill="none" stroke="#324b58" strokeWidth="3" strokeLinecap="round" />
              <ellipse cx="420" cy="109" rx="2.7" ry="4" fill="#45c9ec" />
              <path d="m414 116-5 15 11 2" fill="none" stroke="#8c9c9c" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
              <g className={`receptionist-mouth ${isSpeaking ? "mouth-speaking" : ""}`}>
                <path className="mouth-closed" d="M397 154q11 9 22 0" fill="none" stroke="#607b82" strokeWidth="2.5" strokeLinecap="round" />
                <path className="mouth-open" d="M397 151q11-2 22 0l-2 8q-9 7-18 0z" fill="#263943" stroke="#607b82" strokeWidth="2" strokeLinejoin="round" />
                <path className="mouth-teeth" d="M400 152q8-2 16 0l-1 3h-14z" fill="#fffdf2" />
              </g>
              <path d="M376 91q9-10 22-7M412 89q8-7 16 1" fill="none" stroke="#536a73" strokeWidth="3" strokeLinecap="round" />
              <path d="M356 66q-15 26-8 55l-11-16q-7-30 19-49Z" fill="#6b8c9a" opacity=".7" />

              <path d="M345 184q-4 33 9 58l-21 26-49 30q-27 19-30 56l-8 103 87 12 28-123 46-47 48 51 33 107 78-20-29-121q-8-36-38-57l-44-35q10-35 4-53-29 32-65 29-29-2-49-16Z" fill="url(#shell)" stroke="#f6f8e9" strokeWidth="4" />
              <path d="M362 195q18 19 42 17 26-1 43-23l7 26q-18 29-50 31-34 1-54-23z" fill="url(#dark-metal)" stroke="#56727c" strokeWidth="2" />
              <path d="M366 211q10 25 39 27 28-2 44-25" fill="none" stroke="#56d7e7" strokeOpacity=".72" strokeWidth="3" />

              <path d="M347 244q-29 4-50 28l-49 72 30 22 62-46 29-45z" fill="url(#shell)" stroke="#eef4e9" strokeWidth="4" />
              <circle cx="253" cy="347" r="18" fill="url(#dark-metal)" stroke="#80ddec" strokeWidth="3" />
              <circle cx="253" cy="347" r="8" fill="#47d4e8" />
              <path d="m247 359-30 62q-7 18 12 21l172 1q19-1 16-18-3-13-19-12l-145-2 22-57z" fill="url(#shell)" stroke="#f8f7e9" strokeWidth="4" />
              <path d="M224 420h43" stroke="#9cbbc0" strokeWidth="5" />
              <circle cx="410" cy="431" r="14" fill="url(#dark-metal)" stroke="#75d9e5" strokeWidth="3" />
              <circle cx="410" cy="431" r="5" fill="#6ceaff" />

              <path d="M463 265q32 16 46 51l38 94-27 19-54-76-36-37z" fill="url(#shell)" stroke="#f4f5e9" strokeWidth="4" />
              <circle cx="537" cy="405" r="17" fill="url(#dark-metal)" stroke="#8ae9ee" strokeWidth="3" />
              <circle cx="537" cy="405" r="7" fill="#58ddeb" />
              <path d="m540 418 53 17q17 8 10 22-5 11-19 7l-60-18-10-25z" fill="url(#shell)" stroke="#f7f5e8" strokeWidth="4" />
              <path d="M584 452q22 13 31 4l15-9q7-6 13-2l9 8q4 4-2 8l-17 9q-16 8-37 1l-19-7z" fill="url(#face-shell)" stroke="#eaf3e8" strokeWidth="3" />

              <path d="M348 277q45 25 95-2l27 57-41 49-77-7-35-48z" fill="#f5f4e9" opacity=".76" />
              <path d="m374 307 18 13-9 16-18-12zm48 4 17 12-7 16-19-10zm-30 38 18-12 15 14-19 13z" fill="url(#dark-metal)" stroke="#6edcf0" strokeWidth="2" />
              <circle cx="392" cy="328" r="3" fill="#67ecff" />
              <circle cx="427" cy="330" r="3" fill="#67ecff" />
              <circle cx="406" cy="359" r="3" fill="#67ecff" />
              <path d="M316 296q20-24 39-27M462 289q23 16 37 39" fill="none" stroke="#fffdf1" strokeOpacity=".76" strokeWidth="5" strokeLinecap="round" />
              <path d="M355 268q-18 44-13 104M471 307q25 43 28 88" fill="none" stroke="#a1bdc1" strokeOpacity=".72" strokeWidth="4" />
            </g>

            <g className={isConnected ? "call-arm is-answering" : "call-arm"} aria-hidden="true">
              <path d="M481 276q26 20 40 53l27 64" fill="none" stroke="#142536" strokeWidth="33" strokeLinecap="round" />
              <path d="M481 276q26 20 40 53l27 64" fill="none" stroke="url(#shell)" strokeWidth="25" strokeLinecap="round" />
              <circle cx="548" cy="394" r="17" fill="url(#dark-metal)" stroke="#79e3ee" strokeWidth="3" />
              <circle cx="548" cy="394" r="6" fill="#54deed" />
              {isConnected ? (
                <>
                  <path d="m545 381-27-73 5-43" fill="none" stroke="#142536" strokeWidth="31" strokeLinecap="round" />
                  <path d="m545 381-27-73 5-43" fill="none" stroke="url(#shell)" strokeWidth="23" strokeLinecap="round" />
                  <circle cx="523" cy="304" r="14" fill="url(#dark-metal)" stroke="#7be5ee" strokeWidth="3" />
                  <path d="m521 267 5-31 13-20" fill="none" stroke="#f4f3e7" strokeWidth="17" strokeLinecap="round" />
                  <path d="m536 217 10-12" stroke="#f4f3e7" strokeWidth="10" strokeLinecap="round" />
                  <g className="call-handset" filter="url(#blue-glow)">
                    <path d="M532 183q5-9 14-5l10 5q6 4 3 10l-5 8q-3 5-8 2l-8-5q-5-4-9-1l-5 5q-4 4-9 1l-8-6q-5-4-1-10 10-17 26-21Z" fill="#101c2b" stroke="#88edff" strokeWidth="3" transform="rotate(23 527 193)" />
                    <path d="m513 193 9 6m16-12 9 6" stroke="#68ddfa" strokeWidth="2" strokeLinecap="round" />
                  </g>
                  <path d="M530 206q20 10 31 25 9 12 3 22-4 7-10 2" fill="none" stroke="#132a3a" strokeWidth="3" />
                </>
              ) : (
                <>
                  <path d="m548 395 34 29" fill="none" stroke="url(#shell)" strokeWidth="18" strokeLinecap="round" />
                  <path d="m579 421 12 7" stroke="#f6f5e9" strokeWidth="10" strokeLinecap="round" />
                </>
              )}
            </g>

            <g aria-hidden="true">
              <path d="M620 433h151l-17 61H599z" fill="#121e2a" stroke="#58727d" strokeWidth="3" />
              <path d="m633 441 126-1-13 40-130 1z" fill="#253c4b" stroke="#7bd9e6" strokeWidth="2" />
              <rect x="695" y="445" width="46" height="17" rx="3" fill="#4bbcd0" />
              <path d="M700 450h35M700 455h23" stroke="#b4f6ff" strokeWidth="2" />
              <g fill="#ccd6cd">
                <rect x="648" y="450" width="8" height="6" rx="1" /><rect x="660" y="450" width="8" height="6" rx="1" /><rect x="672" y="450" width="8" height="6" rx="1" />
                <rect x="643" y="461" width="8" height="6" rx="1" /><rect x="655" y="461" width="8" height="6" rx="1" /><rect x="667" y="461" width="8" height="6" rx="1" /><rect x="679" y="461" width="8" height="6" rx="1" />
                <rect x="693" y="467" width="8" height="6" rx="1" /><rect x="705" y="467" width="8" height="6" rx="1" /><rect x="717" y="467" width="8" height="6" rx="1" />
              </g>
              {!isConnected && (
                <g className="resting-handset">
                  <path d="M535 404q6-8 14-3l10 7q5 4 1 10l-5 7q-4 5-9 1l-8-6q-5-3-9 0l-5 5q-5 4-10 0l-7-7q-4-5 1-10 11-14 27-14Z" fill="#101c2b" stroke="#86e9f8" strokeWidth="3" transform="rotate(24 527 411)" />
                </g>
              )}
            </g>

            <g opacity=".72" fill="#a7f5ff">
              <circle cx="591" cy="127" r="2" /><circle cx="610" cy="154" r="1.5" /><circle cx="794" cy="176" r="2" />
              <circle cx="780" cy="242" r="1.5" /><circle cx="568" cy="219" r="2" /><circle cx="814" cy="299" r="1.5" />
            </g>
          </svg>
          <svg className="reception-scene human-scene" viewBox="0 0 840 620" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
            <defs>
              <linearGradient id="human-room" x1="0" y1="0" x2="1" y2="1">
                <stop stopColor="#f8f8f3" />
                <stop offset=".58" stopColor="#e6ecea" />
                <stop offset="1" stopColor="#c7d9dc" />
              </linearGradient>
              <linearGradient id="human-window" x1="0" y1="0" x2="1" y2="1">
                <stop stopColor="#d8f0f6" />
                <stop offset=".55" stopColor="#f4f8f7" />
                <stop offset="1" stopColor="#bedbe2" />
              </linearGradient>
              <linearGradient id="human-skin" x1="0" y1="0" x2=".86" y2="1">
                <stop stopColor="#ffe0c7" />
                <stop offset=".55" stopColor="#f3bd9d" />
                <stop offset="1" stopColor="#d89478" />
              </linearGradient>
              <linearGradient id="human-hair" x1="0" y1="0" x2="1" y2=".8">
                <stop stopColor="#211b1b" />
                <stop offset=".48" stopColor="#49302a" />
                <stop offset="1" stopColor="#17171a" />
              </linearGradient>
              <linearGradient id="human-jacket" x1="0" y1="0" x2="1" y2="1">
                <stop stopColor="#243f66" />
                <stop offset=".52" stopColor="#112a4c" />
                <stop offset="1" stopColor="#081b34" />
              </linearGradient>
              <linearGradient id="human-blouse" x1="0" y1="0" x2="1" y2="1">
                <stop stopColor="#fff" />
                <stop offset="1" stopColor="#e6e9e7" />
              </linearGradient>
              <linearGradient id="human-desk" x1="0" y1="0" x2="0" y2="1">
                <stop stopColor="#fff" />
                <stop offset=".72" stopColor="#f3f5f3" />
                <stop offset="1" stopColor="#d9dfde" />
              </linearGradient>
              <linearGradient id="human-phone" x1="0" y1="0" x2="1" y2="1">
                <stop stopColor="#fff" />
                <stop offset=".58" stopColor="#e8ecea" />
                <stop offset="1" stopColor="#b9c4c4" />
              </linearGradient>
              <filter id="human-shadow" x="-.25" y="-.3" width="1.6" height="1.7">
                <feGaussianBlur in="SourceAlpha" stdDeviation="8" />
                <feOffset dy="7" />
                <feComponentTransfer><feFuncA type="linear" slope=".2" /></feComponentTransfer>
                <feMerge><feMergeNode /><feMergeNode in="SourceGraphic" /></feMerge>
              </filter>
              <filter id="background-soft">
                <feGaussianBlur stdDeviation="2" />
              </filter>
            </defs>

            <rect width="840" height="620" fill="url(#human-room)" />
            <path d="M0 0h840v444H0z" fill="#f4f5f0" />
            <path d="M0 34h470M0 48h516" stroke="#fff" strokeWidth="10" opacity=".72" />
            <path d="M625 0h215v438H625z" fill="url(#human-window)" />
            <path d="M635 0v437m91-437v437m91-437v437M625 140h215M625 282h215" stroke="#fff" strokeOpacity=".75" strokeWidth="5" />
            <path d="M635 10h195v409H635z" fill="#d5edf1" opacity=".17" />
            <path d="M652 32h168" stroke="#fff" strokeWidth="7" opacity=".65" />
            <path d="M570 142h108v230H570z" fill="#c9b19a" />
            <path d="M570 142h108v34H570z" fill="#efe6d8" />
            <path d="M570 280h108v34H570z" fill="#eee4d5" />
            <path d="M582 185h81v79h-81z" fill="#6b7374" />
            <path d="M583 193h79v8h-79z" fill="#535f62" />
            <path d="M601 129q20-25 39 0l-3 13h-32z" fill="#426b50" />
            <path d="M606 132q-13-31 4-45m16 45q18-26 14-44m-19 38q-27-19-34-17m35 9q24-19 35-17" fill="none" stroke="#57845c" strokeWidth="8" strokeLinecap="round" />
            <path d="M0 350h840v95H0z" fill="#e6e8e4" />

            <g opacity=".88">
              <path d="M43 260h201v186H43z" fill="#202b34" />
              <path d="M52 270h183v155H52z" fill="#171f27" />
              <path d="M62 287h165v120H62z" fill="#25323c" />
              <path d="M64 302h158M64 318h158M64 334h158M64 350h158M64 366h158M64 382h158" stroke="#39434a" strokeWidth="4" />
              <path d="M46 290h194" stroke="#56636a" strokeWidth="5" />
            </g>

            <g opacity=".86" filter="url(#background-soft)">
              <circle cx="214" cy="241" r="19" fill="#c78f74" />
              <path d="M196 240q3-32 36-19l3 19-39 5Z" fill="#413232" />
              <path d="M189 268q25-17 50 0l20 95h-90z" fill="#e8eeeb" />
              <path d="M158 361h101v15H158z" fill="#68767b" />
              <path d="M167 376h8v52h-8zm76 0h8v52h-8z" fill="#6c7778" />
            </g>

            <g opacity=".58">
              <path d="M719 280h108v87H719z" fill="#31404a" />
              <path d="M726 288h94v67h-94z" fill="#92cad1" />
              <path d="M737 302h70M737 316h55M737 330h72M737 343h48" stroke="#fff" strokeWidth="3" opacity=".72" />
            </g>

            <path d="M0 440h840v180H0z" fill="url(#human-desk)" />
            <path d="M0 440h840" stroke="#fff" strokeWidth="8" />
            <path d="M0 457h840" stroke="#d4dcda" strokeWidth="3" />
            <path d="M0 602h840" stroke="#cbd5d3" strokeWidth="2" />

            <g opacity=".98">
              <path d="M84 265q4-25 29-26h124q24 0 28 25v171H86z" fill="#27313b" />
              <path d="M99 286h151m-151 46h151m-151 46h151" stroke="#3a444d" strokeWidth="8" opacity=".68" />
              <path d="M100 435h153v18H100z" fill="#1e2830" />
            </g>

            <g filter="url(#human-shadow)">
              <path d="M330 232q-52 17-77 63l-38 123 56 30 79-115 25-75z" fill="url(#human-jacket)" />
              <path d="M452 231q50 17 66 62l41 95-45 33-68-98-26-64z" fill="url(#human-jacket)" />

              <path d="M360 190h68v65h-68z" fill="url(#human-skin)" />
              <path d="M347 213q39 30 80-1l33 27-15 196H310l7-168q-2-30 30-54z" fill="url(#human-jacket)" />
              <path d="M366 207h55l32 31-28 38-22-17-20 17-39-39z" fill="url(#human-blouse)" />
              <path d="m390 226 15 37 16-38-14-9z" fill="#d9dddc" />
              <path d="M362 213 330 235l26 32-13 18 13 113M424 214l32 23-22 31 15 19-12 112" fill="none" stroke="#456182" strokeWidth="4" opacity=".72" />
              <path d="M400 279v134" stroke="#d8e1e1" strokeWidth="3" />
              <circle cx="400" cy="303" r="3" fill="#a9b6bc" />
              <circle cx="400" cy="325" r="3" fill="#a9b6bc" />

              <path d="M347 73q22-47 78-32 46 16 42 90l-13 91q-9 43-55 54-52-9-65-53l-12-88q-4-40 25-62z" fill="url(#human-hair)" />
              <path d="M365 87q29-22 64 1 24 20 17 66l-8 57q-7 34-38 45-36-7-45-40l-10-65q-5-43 20-64z" fill="url(#human-skin)" />
              <path d="M357 124q2-56 51-66 41 1 50 43-29-26-53-17-17 14-48 14z" fill="url(#human-hair)" />
              <path d="M354 106q-26 21-19 93l12 58q-30-21-33-69l-1-57q12-45 41-54z" fill="#32231f" />
              <path d="M445 109q24 25 12 92l-9 51q30-20 34-64l-4-56q-8-30-33-42z" fill="#2e211f" />
              <path d="M354 177q-15-5-17 12 1 15 17 12" fill="url(#human-skin)" />
              <path d="M453 176q14-5 17 12-2 15-17 12" fill="url(#human-skin)" />
              <path d="M365 150q12-8 25-1m25 0q13-8 25 0" fill="none" stroke="#51423c" strokeWidth="3" strokeLinecap="round" />
              <path d="M369 160q9-7 18 0m31 0q9-7 18 0" fill="none" stroke="#443b38" strokeWidth="2" strokeLinecap="round" />
              <ellipse cx="379" cy="161" rx="2.5" ry="3.5" fill="#344a4b" />
              <ellipse cx="427" cy="161" rx="2.5" ry="3.5" fill="#344a4b" />
              <path d="m403 164-5 19 9 2" fill="none" stroke="#d29178" strokeWidth="2" strokeLinecap="round" />
              <ellipse cx="369" cy="185" rx="10" ry="6" fill="#e99f97" opacity=".25" />
              <ellipse cx="438" cy="185" rx="10" ry="6" fill="#e99f97" opacity=".25" />
              <g className={`receptionist-mouth ${isSpeaking ? "mouth-speaking" : ""}`}>
                <path className="mouth-closed" d="M389 194q14 13 29 0" fill="none" stroke="#9c4f51" strokeWidth="3" strokeLinecap="round" />
                <path className="mouth-open" d="M389 191q14-3 29 0l-2 10q-12 9-25 0z" fill="#713c42" stroke="#9c4f51" strokeWidth="2" strokeLinejoin="round" />
                <path className="mouth-teeth" d="M393 192q10-3 21 0l-1 4h-19z" fill="#fffaf3" />
              </g>
              <path d="M383 204q18 11 37 0" fill="none" stroke="#d5917a" strokeWidth="2" opacity=".55" />

              <path d="M323 401q27 19 63 26l36 11q16 7 8 20-6 10-22 5l-94-24q-19-6-14-24z" fill="url(#human-skin)" />
              <path d="M330 402q16 24 45 29l29 9" fill="none" stroke="#d9957c" strokeWidth="3" opacity=".7" />
              <path d="M450 405q-16 20-39 29l-22 8" fill="none" stroke="#d9957c" strokeWidth="3" opacity=".7" />
              {isConnected ? (
                <g className="human-call-arm">
                  <path d="M456 264q24 7 28 40l-3 47q-1 22 10 35" fill="none" stroke="url(#human-jacket)" strokeWidth="38" strokeLinecap="round" />
                  <path d="M457 266q24 8 26 38" fill="none" stroke="#415c7a" strokeWidth="4" opacity=".7" />
                  <path d="M489 386q-2-20 6-34l-4-59q-1-17 12-19 14-1 14 17l1 51q15 2 13 15l-4 29q-4 18-21 21-13 2-17-10z" fill="url(#human-skin)" />
                  <path d="M510 281q-4-26-2-48l-1-18" fill="none" stroke="url(#human-skin)" strokeWidth="12" strokeLinecap="round" />
                  <path d="M520 282q4-23 8-43l-1-21" fill="none" stroke="url(#human-skin)" strokeWidth="11" strokeLinecap="round" />
                  <path d="M528 291q13-18 17-34l2-15" fill="none" stroke="url(#human-skin)" strokeWidth="10" strokeLinecap="round" />
                  <path d="M495 284q-12-20-17-35l-3-16" fill="none" stroke="url(#human-skin)" strokeWidth="10" strokeLinecap="round" />
                  <g className="human-handset">
                    <path d="M470 122q-1-12 11-14l14-1q10 0 11 11l1 17q0 9-9 10l-8 1q-4 0-4 5l2 24q1 5 6 5l8-1q9-1 11 8l3 16q2 11-8 14l-13 4q-12 3-19-8-29-42-30-76-1-11 10-14l15-1Z" fill="url(#human-phone)" stroke="#bbc5c5" strokeWidth="3" />
                    <path d="M478 115q8-6 16-3l-1 28q-8 0-13 5zM481 182q9 4 18 1l5 25q-7 7-17 6z" fill="#d2d9d7" />
                  </g>
                </g>
              ) : (
                <path d="M450 398q-8 27-39 37l-35 11q-14 8-7 20 7 9 20 4l74-23q24-9 28-30l-7-26z" fill="url(#human-skin)" />
              )}
            </g>

            <g aria-hidden="true">
              <path d="M35 455h205l-8 13H43z" fill="#d7c5a5" />
              <path d="M47 442h186v14H47z" fill="#30486a" />
              <path d="M49 439h184" stroke="#e8e7df" strokeWidth="5" />
              <path d="M269 465h151v24H269z" fill="#f8f8f4" stroke="#ccd2d0" strokeWidth="2" />
              <path d="M278 473h131" stroke="#bac8cc" strokeWidth="2" />
              <path d="M277 483h84" stroke="#d6dedf" strokeWidth="2" />
              <path d="M620 100h174v280H620z" fill="#f9fbfa" stroke="#d1d9d8" strokeWidth="8" />
              <path d="M630 112h155v239H630z" fill="url(#human-window)" />
              <path d="M639 119h140" stroke="#fff" strokeWidth="12" opacity=".74" />
              <path d="M638 360h142" stroke="#dce4e2" strokeWidth="4" />

              <path d="M526 438q13-29 33-30h139q22 4 33 23l-13 54H514z" fill="url(#human-phone)" stroke="#b8c2c1" strokeWidth="4" />
              <path d="M547 433q17-16 41-16h92q18 1 32 14l-3 12H541z" fill="#f7f8f5" stroke="#cbd3d1" strokeWidth="3" />
              <path d="M561 437h132" stroke="#d0d8d6" strokeWidth="3" />
              <path d="M533 466h177" stroke="#bfc8c7" strokeWidth="3" />
              <path d="M561 476h114" stroke="#fdfefd" strokeWidth="7" />
              {isConnected ? (
                <g className="human-phone-base-handset">
                  <path d="M576 406q-5-8 3-13l12-7q9-5 14 4l5 9q4 8-4 13l-7 4q-4 3-1 7l13 20q3 4 8 1l7-4q8-5 14 2l9 9q7 8-1 16l-9 10q-8 9-20 3-40-21-57-52-6-10 3-17l11-8Z" fill="url(#human-phone)" stroke="#b8c2c1" strokeWidth="3" transform="rotate(-12 615 433)" />
                </g>
              ) : (
                <path d="M576 406q-5-8 3-13l12-7q9-5 14 4l5 9q4 8-4 13l-7 4q-4 3-1 7l13 20q3 4 8 1l7-4q8-5 14 2l9 9q7 8-1 16l-9 10q-8 9-20 3-40-21-57-52-6-10 3-17l11-8Z" fill="url(#human-phone)" stroke="#b8c2c1" strokeWidth="3" transform="rotate(-12 615 433)" />
              )}
              <path d="M604 425q-6 22-15 24t-11 10q-3 8 9 11t18-3 13-12" fill="none" stroke="#c4cbca" strokeWidth="4" strokeLinecap="round" />
            </g>
          </svg>

          <div className="robot-caption">
            <span className="caption-status-dot" />
            <span>Aanya</span>
            <span className="caption-divider">·</span>
            <span>AI Dental Assistant</span>
          </div>
          <div className="floating-card floating-card-top">
            <span className="floating-card-icon">✦</span>
            <span>Here to help</span>
          </div>
          <div className="visual-metric diagnostic-metric" aria-hidden="true">
            <div className="metric-heading"><span /> DIAGNOSTIC <span>···</span></div>
            <div className="diagnostic-content">
              <div className="metric-gauge"><span>5.58</span></div>
              <div className="metric-legend"><span>Healthy <i>75%</i></span><span>Good <i>20%</i></span><span>Review <i>5%</i></span></div>
            </div>
            <div className="metric-track"><span /></div>
          </div>
          <div className="visual-metric clinic-metric" aria-hidden="true">
            <div className="metric-heading">CLINIC METRIC <span>···</span></div>
            <div className="metric-columns"><i /><i /><i /><i /></div>
          </div>
          <div className="visual-metric waveform-metric" aria-hidden="true">
            <div className="metric-heading">DIAGNOSTIC <span>···</span></div>
            <svg viewBox="0 0 112 42" fill="none">
              <path d="M2 31c13 0 11-21 23-21s10 19 22 19 12-23 23-23 10 22 22 22 10-12 18-12" stroke="#74f6ed" strokeWidth="3" strokeLinecap="round" />
            </svg>
            <div className="wave-days"><span>M</span><span>T</span><span>W</span><span>T</span><span>F</span></div>
          </div>
          <div className="visual-metric side-metric" aria-hidden="true">
            <div className="metric-heading">LIVE SIGNAL <span>···</span></div>
            <div className="metric-columns"><i /><i /><i /><i /><i /></div>
          </div>
          <div className="network-decoration" aria-hidden="true">✧</div>
        </div>
      </section>

      <section className="below-fold-content">
        <div className="services-panel" id="services">
          <h2>Our Services</h2>
          <div className="service-list">
            <a href="#call-assistant" className="service-card">
              <svg viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M16 5c-2-1.5-6-1-7.2 1.8-1.2 2.5.2 5.2 1 7.6.7 2.1 1 7.2 3.3 7.7 1.8.3 2-4.7 3.5-4.7s1.7 5 3.5 4.7c2.3-.5 2.6-5.6 3.3-7.7.8-2.4 2.2-5.1 1-7.6C23.2 4 18.3 3.5 16 5Z" stroke="currentColor" strokeWidth="1.7" /></svg>
              <span>General Dentistry</span>
            </a>
            <a href="#call-assistant" className="service-card">
              <svg viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M16 5 18 12l7 2-7 2-2 7-2-7-7-2 7-2 2-7Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" /><path d="m24 21 1.2 3.8L29 26l-3.8 1.2L24 31l-1.2-3.8L19 26l3.8-1.2L24 21Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /></svg>
              <span>Cosmetic Care</span>
            </a>
            <a href="#call-assistant" className="service-card">
              <svg viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M4 12h24M4 12l2-5h20l2 5v8l-2 5H6l-2-5v-8Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /><circle cx="11" cy="16" r="3" stroke="currentColor" strokeWidth="1.5" /><circle cx="21" cy="16" r="3" stroke="currentColor" strokeWidth="1.5" /><path d="M14 16h4" stroke="currentColor" strokeWidth="1.5" /></svg>
              <span>Orthodontics</span>
            </a>
          </div>
        </div>

        <div className="portal-panel" id="patient-portal">
          <h2>Patient Portal</h2>
          <div className="portal-preview" aria-label="Patient portal preview">
            <span className="portal-input-placeholder">Login</span>
            <span className="portal-input-placeholder">Password</span>
            <span className="portal-preview-note">Portal sign-in is not set up yet.</span>
          </div>
        </div>
      </section>

      <footer className="page-footer" id="clinic-hours">
        <span>Thoughtful care starts with a conversation.</span>
        <div className="footer-links">
          <a href="#about">Home</a>
          <a href="#about">About Us</a>
          <a href="#call-assistant">Contact us</a>
          <a href="#patient-portal">Login</a>
        </div>
        <span className="footer-hours"><span /> Clinic hours: 10 AM – 8 PM</span>
      </footer>
    </main>
  );
}
