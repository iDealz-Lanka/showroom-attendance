# 🏢 Idealz Attendance System
### Next.js + Firebase + Vercel


---

## 🚀 Setup Guide — Follow in Order

---

### STEP 1 — Install dependencies
Open this folder in VS Code terminal:
```bash
npm install
```

---

### STEP 2 — Create Firebase Project (free)

1. Go to **https://console.firebase.google.com**
2. Click **"Add project"** → name it `showroom-attendance` → Continue
3. Disable Google Analytics (not needed) → **Create project**
4. Click **"Firestore Database"** in the left sidebar
5. Click **"Create database"**
6. Choose **"Start in test mode"** → select your region → **Enable**

---

### STEP 3 — Get your Firebase config keys

1. In Firebase Console, click the ⚙️ gear icon → **Project settings**
2. Scroll down to **"Your apps"** → click **"</> Web"**
3. Register app name as `showroom-web` → click **Register app**
4. You'll see a config object like:
```js
const firebaseConfig = {
  apiKey: "AIza...",
  authDomain: "showroom-xxx.firebaseapp.com",
  projectId: "showroom-xxx",
  storageBucket: "showroom-xxx.appspot.com",
  messagingSenderId: "123456789",
  appId: "1:123:web:abc123"
}
```
5. Copy each value into your `.env.local` file (see Step 4)

---

### STEP 4 — Add your keys to .env.local

Open the `.env.local` file and fill in your values:
```
NEXT_PUBLIC_FIREBASE_API_KEY=AIza...
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
NEXT_PUBLIC_FIREBASE_PROJECT_ID=your-project-id
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=your-project.appspot.com
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=123456789
NEXT_PUBLIC_FIREBASE_APP_ID=1:123:web:abc...
```

---

### STEP 5 — Run locally
```bash
npm run dev
```
Open **http://localhost:3000**

On first load, it will automatically seed 5 sample employees.
Test check-in/out — fingerprint will prompt (or simulate if no sensor).

---

### STEP 6 — Push to GitHub

1. Create a new repo at **https://github.com/new**
   - Name: `showroom-attendance`
   - Keep it **Private** (your keys are in .env.local which is gitignored ✅)
2. Run in your terminal:
```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/showroom-attendance.git
git push -u origin main
```

---

### STEP 7 — Deploy to Vercel

1. Go to **https://vercel.com** → Sign in with GitHub
2. Click **"Add New Project"** → import `showroom-attendance`
3. Before clicking Deploy, open **"Environment Variables"** and add ALL 6 keys from your `.env.local`:
   - `NEXT_PUBLIC_FIREBASE_API_KEY`
   - `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`
   - `NEXT_PUBLIC_FIREBASE_PROJECT_ID`
   - `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`
   - `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID`
   - `NEXT_PUBLIC_FIREBASE_APP_ID`
4. Click **Deploy** ✅

Your live URL will be: `https://showroom-attendance.vercel.app`

---

### STEP 8 — Set up at each showroom

On each showroom computer or tablet:
1. Open **Chrome** or **Edge**
2. Go to your Vercel URL
3. Bookmark it or press `F11` for fullscreen kiosk mode
4. The fingerprint button uses the device's built-in sensor automatically

---

## 📁 Project Structure

```
showroom-attendance/
├── pages/
│   ├── index.js           ← Full attendance UI
│   ├── _app.js
│   └── api/
│       ├── employees.js   ← Add/get/delete employees
│       ├── records.js     ← Save & query attendance
│       ├── stats.js       ← Dashboard counts
│       └── seed.js        ← Seeds default employees once
├── lib/
│   └── firebase.js        ← Firebase client
├── styles/
│   └── globals.css
├── .env.local             ← Your secret keys (never committed)
├── next.config.js
└── package.json
```

---

## ✅ Features

- 👆 Fingerprint check-in / check-out (WebAuthn API)
- 🏢 3 showroom support with live headcount
- 🕐 Short leave requests with duration & reason
- 📋 Real-time activity log
- 📊 Reports with filters (showroom / employee / date / type)
- ⬇ CSV export
- 👥 Admin panel — add/remove employees
- 🔥 Firebase Firestore real-time database
- 🚀 Deployed globally on Vercel

---

## 💡 Tips

- **No fingerprint sensor?** Falls back to simulated scan automatically.
- **All showrooms** use the same URL — they just select their showroom.
- **Firestore rules** are set to test mode. For production, update them in Firebase Console → Firestore → Rules.
