const fs = require("fs");
const path = require("path");

const requiredSourceFiles = [
  "app/page.js",
  "app/api/session/route.js",
  "app/api/appointments/route.js",
];
for (const filePath of requiredSourceFiles) {
  if (!fs.existsSync(path.join(__dirname, filePath))) {
    throw new Error(`Required Gemini app source is missing: ${filePath}`);
  }
}

const files = {
  "package.json": JSON.stringify({
    name: "dental-web-agent",
    version: "0.1.0",
    private: true,
    scripts: {
      dev: "next dev",
      build: "next build",
      start: "next start",
    },
    dependencies: {
      next: "^14.2.15",
      react: "^18.3.1",
      "react-dom": "^18.3.1",
    },
    devDependencies: {
      postcss: "^8.4.38",
      tailwindcss: "^3.4.3",
      autoprefixer: "^10.4.19",
    },
  }, null, 2),
  "tailwind.config.js": `/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: { extend: {} },
  plugins: [],
};`,
  "postcss.config.js": `module.exports = {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};`,
  ".env.local": "GEMINI_API_KEY=YOUR_GEMINI_API_KEY_HERE",
  ".env.example": `GEMINI_API_KEY=YOUR_GEMINI_API_KEY_HERE
GOOGLE_APPS_SCRIPT_URL=https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec
GOOGLE_SHEETS_SHARED_SECRET=REPLACE_WITH_A_LONG_RANDOM_SECRET`,
  ".gitignore": `node_modules/
.next/
.env
.env.*
!.env.example
*.pem
service-account*.json
credentials*.json`,
  "app/globals.css": `@tailwind base;
@tailwind components;
@tailwind utilities;

body {
  background-color: #0f172a;
  color: white;
  font-family: system-ui, -apple-system, sans-serif;
}`,
  "app/layout.js": `import './globals.css';

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
}`,
};

for (const [filePath, content] of Object.entries(files)) {
  const fullPath = path.join(__dirname, filePath);
  if (filePath === ".env.local" && fs.existsSync(fullPath)) {
    console.log("Preserved existing .env.local; add GEMINI_API_KEY if it is missing.");
    continue;
  }

  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content.trim(), "utf8");
  console.log(`Created: ${filePath}`);
}

console.log("Gemini app source files were preserved.");
console.log("Next steps:");
console.log("1. Add GEMINI_API_KEY and Apps Script settings to .env.local (see .env.example).");
console.log("2. Follow GOOGLE_SHEETS_SETUP.md to deploy the Apps Script Web App.");
console.log("3. Run: npm run dev");
