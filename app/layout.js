import './globals.css';

export const metadata = {
  title: 'Smile Care - Gemini AI Dental Receptionist',
  description: 'Gemini Live voice receptionist for a dental clinic',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}