# Project Overview: google-lita-sorpa-voice (Litla Sorpa - Raddaðstoð)

## Purpose
A real-time voice assistant that helps users sort trash into the correct bins using Gemini Native Audio. The name translates to "Little Trash - Voice Assistant" in Icelandic. It uses the Gemini Live API for real-time audio conversation about waste sorting.

## Tech Stack
- React 19 with TypeScript
- Vite 6 (build tool)
- Google GenAI SDK (`@google/genai`) — Gemini Live API with native audio
- Gemini 2.5 Flash Native Audio model (`gemini-2.5-flash-native-audio-preview-12-2025`)
- Web Audio API (microphone input, audio output)

## Key Files
- `App.tsx` — Main app component; handles Gemini Live session, audio I/O, and chat log
- `components/Visualizer.tsx` — Audio volume visualizer component
- `utils/audio.ts` — Audio encoding/decoding utilities (blob creation, PCM decoding)
- `types.ts` — TypeScript type definitions (ConnectionState, etc.)
- `metadata.json` — AI Studio app metadata

## Build/Run Commands
- `npm install` — Install dependencies
- `npm run dev` — Run development server
- `npm run build` — Build for production
- Requires `GEMINI_API_KEY` in `.env.local`
- Requires microphone permission in the browser

## Notes
- Google AI Studio exported app
- Uses Gemini Live API for real-time bidirectional audio streaming
- Icelandic-language application (trash sorting assistant for Icelandic users)
- Flat project structure (no src/ directory)
