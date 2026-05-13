# Handscript

A monorepo for the Handscript application — a mobile app for capturing and processing handwritten content.

## Project Structure

```
handscript/
├── mobile/      React Native (Expo) app
├── backend/     Python FastAPI server
└── shared/      Shared TypeScript types and constants
```

---

## mobile/

**Tech:** React Native · Expo SDK 54 · TypeScript

**Key packages:**
| Package | Purpose |
|---|---|
| `@react-navigation/native` + `native-stack` | Screen navigation |
| `expo-camera` | Camera access for capturing handwriting |
| `expo-image-manipulator` | Crop / resize images before upload |
| `expo-sharing` | Share output files |
| `expo-media-library` | Save results to device gallery |
| `expo-file-system` | Local file read/write |

**Getting started:**
```bash
cd mobile
npm install
npx expo start
```

---

## backend/

**Tech:** Python · FastAPI · Uvicorn

**Key packages:**
| Package | Purpose |
|---|---|
| `fastapi` | REST API framework |
| `uvicorn` | ASGI server |
| `python-multipart` | File upload support |
| `opencv-python` | Image processing |
| `Pillow` | Image I/O |
| `numpy` | Numerical operations |
| `firebase-admin` | Firebase / Firestore integration |
| `python-dotenv` | Environment variable loading |

**Getting started:**
```bash
cd backend
python -m venv venv
# Windows
venv\Scripts\activate
# macOS/Linux
source venv/bin/activate

pip install -r requirements.txt
uvicorn main:app --reload
```

Copy `.env.example` to `.env` and fill in your credentials before running.

---

## shared/

Shared TypeScript types and constants consumed by the mobile app.
Expand `shared/index.ts` with your domain types as the project grows.

---

## Development Notes

- No app logic is implemented yet — this is the scaffolded structure only.
- The mobile app targets Android first; iOS requires a Mac with Xcode.
- Backend image processing endpoints will call into OpenCV / Pillow pipelines.
