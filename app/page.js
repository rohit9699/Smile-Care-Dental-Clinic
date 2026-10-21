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
  for (let i = 0; i < pcmBytes.length; i += 1) {
    binary += String.fromCharCode(pcmBytes[i]);
  }
  return btoa(binary);
}

export default function Home() {
  const [isConnected, setIsConnected] = useState(false);
  const [status, setStatus] = useState("Call disconnected. Click again to start.");
  const [isCalling, setIsCalling] = useState(false);
  const socketRef = useRef(null);
  const mediaStreamRef = useRef(null);
  const audioContextRef = useRef(null);
  const playbackSourcesRef = useRef(new Set());
  const microphoneNodesRef = useRef([]);
  const nextPlaybackTimeRef = useRef(0);

  const stopGeneratedAudio = () => {
    for (const source of playbackSourcesRef.current) source.stop();
    playbackSourcesRef.current.clear();
    nextPlaybackTimeRef.current = audioContextRef.current?.currentTime ?? 0;
  };

  const releaseMedia = () => {
    microphoneNodesRef.current.forEach((node) => node.disconnect());
    microphoneNodesRef.current = [];

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
          } catch {
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
            playback.connect(audioContext.destination);
            playback.onended = () => playbackSourcesRef.current.delete(playback);

            const startAt = Math.max(audioContext.currentTime, nextPlaybackTimeRef.current);
            playbackSourcesRef.current.add(playback);
            playback.start(startAt);
            nextPlaybackTimeRef.current = startAt + audioBuffer.duration;
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
      <section className="receptionist-card" aria-labelledby="page-title">
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

          <div
            id="call-assistant"
            className={`assistant-status ${isConnected ? "is-connected" : ""}`}
            aria-live="polite"
          >
            <span className="status-indicator" aria-hidden="true"><span /></span>
            <div className="status-copy">
              <span className="status-label">
                {isCalling ? "CONNECTING" : isConnected ? "YOU'RE CONNECTED" : "READY WHEN YOU ARE"}
              </span>
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

        <div className="robot-stage">
          <img
            className="reception-photo"
            src="/photo1.png"
            alt="Aanya, Smile Care's receptionist, ready to help"
          />
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
        </div>
      </section>
    </main>
  );
}
