# ScreenNote

Turn screenshots into actionable notes, tasks, and reminders — 100% in your browser.

## Features
- 📸 **Upload screenshots** → OCR extracts text via Tesseract.js (client-side, private)
- 🤖 **Auto-classification** — detects tasks, reminders, and notes with dates/times
- 🔗 **Share via link** — share any note as a URL with embedded data (Web Share API + clipboard fallback)
- 🔔 **Alarms & notifications** — set date/time alarms on any note with browser notifications + sound
- 🔍 **Search & filter** — by type (task/reminder/note), keywords, tags, and completion status
- 📦 **Export to JSON** — download all your data anytime
- 💾 **localStorage** — all data stays on your device. No backend, no uploads.

## Tech Stack
- React 19 + TypeScript
- Vite + Tailwind CSS v4
- Tesseract.js (OCR)
- Web Audio API (alarm sounds)
- Web Notification API
- Web Share API

## Quick Start
```bash
npm install
npm run dev
```

## Build
```bash
npm run build
# Output in dist/
```
