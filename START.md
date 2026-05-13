# HandScript — How to Run

## Project location

```
c:\Users\Roey\OneDrive\Desktop\New folder\handscript
```

The `"New folder"` name has a space — you must quote the path or `cd` into it in two steps.

---

## Step 1 — Start the backend

Open **Terminal 1** and run:

```powershell
cd "c:\Users\Roey\OneDrive\Desktop\New folder\handscript\backend"
```

First time only — create and activate the virtual environment:

```powershell
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
```

Every time — start the server:

```powershell
venv\Scripts\activate
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

You should see:
```
INFO:     Uvicorn running on http://0.0.0.0:8000
```

Test it is working by opening http://localhost:8000/health in your browser — you should see `{"status":"ok"}`.

---

## Step 2 — Start the mobile app

Open **Terminal 2** and run:

```powershell
cd "c:\Users\Roey\OneDrive\Desktop\New folder\handscript\mobile"
npm install        # first time only
npx expo start
```

Scan the QR code with **Expo Go** on your phone.

---

## Step 3 — Phone ↔ backend connection (IMPORTANT)

The backend auto-detection is already wired in via `expo-constants`.
When you scan the QR code with a physical device on the same WiFi, the app
reads the bundler IP and uses `http://<that-ip>:8000` automatically.

**Your current computer IP on Wi-Fi:** `10.98.5.248`

**Requirements:**
- Your phone and your computer must be on the **same WiFi network**
- The backend must be running (`uvicorn`) before you test the upload
- Windows Firewall must allow port 8000 — run this once if uploads time out:

```powershell
netsh advfirewall firewall add rule name="HandScript Backend" dir=in action=allow protocol=TCP localport=8000
```

### Manual override (if auto-detection ever fails)

Edit `mobile\.env` and set:

```
EXPO_PUBLIC_BACKEND_URL=http://10.98.5.248:8000
```

Then restart Expo (`s` → `r` in the Expo terminal, or restart `npx expo start`).

---

## Step 4 — Verify end-to-end

1. Backend running → `http://localhost:8000/health` returns `{"status":"ok"}`
2. Expo started → QR code visible in terminal
3. Phone connected → app loads on device
4. Take a photo → should finish in <10 s (not hang for minutes)

If upload times out after 20 s you will now see a clear error:
> "פסק זמן: השרת לא ענה תוך 20 שניות. ודא שהשרת פועל ושאתה באותה רשת WiFi."

---

## File structure (all files present)

```
handscript/
├── START.md                        ← this file
├── backend/
│   ├── main.py                     ✅
│   ├── requirements.txt            ✅
│   ├── railway.json                ✅  (Railway deployment)
│   ├── nixpacks.toml               ✅
│   └── modules/
│       ├── extractor.py            ✅
│       ├── synthesizer.py          ✅
│       ├── layout.py               ✅
│       ├── validator.py            ✅
│       └── firebase_client.py      ✅
└── mobile/
    ├── App.tsx                     ✅
    ├── package.json                ✅
    ├── .env                        ✅  (set EXPO_PUBLIC_BACKEND_URL for prod)
    ├── src/
    │   ├── config.ts               ✅  (auto-detects dev IP)
    │   ├── utils/api.ts            ✅  (20 s timeout added)
    │   ├── services/
    │   │   ├── auth.ts             ✅
    │   │   ├── firebase.ts         ✅
    │   │   └── subscription.ts     ✅
    │   └── components/
    │       ├── ErrorBoundary.tsx   ✅
    │       └── LoadingOverlay.tsx  ✅
    └── screens/
        ├── CameraScreen.tsx        ✅
        ├── ReviewScreen.tsx        ✅
        ├── EditorScreen.tsx        ✅
        ├── PreviewScreen.tsx       ✅
        ├── ProfileScreen.tsx       ✅
        └── OnboardingScreen.tsx    ✅
```
