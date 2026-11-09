const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");

const app = express();

app.use(cors({
  origin: true,
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.use(express.json({ limit: "1mb" }));

// Firebase Admin SDK
if (!admin.apps.length) {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const serviceAccount = JSON.parse(
      process.env.FIREBASE_SERVICE_ACCOUNT
    );

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
  } else {
    admin.initializeApp();
  }
}

const db = admin.firestore();
const auth = admin.auth();

const PORT = process.env.PORT || 8000;

async function verifyUser(req, res, next) {
  try {
    const header = req.headers.authorization || "";

    if (!header.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "Token login tidak ditemukan"
      });
    }

    const token = header.substring(7);
    const decoded = await auth.verifyIdToken(token);

    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: "Login tidak valid atau sudah kedaluwarsa"
    });
  }
}

async function verifyAdmin(req, res, next) {
  try {
    const userDoc = await db
      .collection("users")
      .doc(req.user.uid)
      .get();

    if (!userDoc.exists || userDoc.data().role !== "admin") {
      return res.status(403).json({
        success: false,
        message: "Akses khusus admin"
      });
    }

    next();
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Gagal memeriksa hak akses"
    });
  }
}

// Health check
app.get("/", (req, res) => {
  res.json({
    success: true,
    app: "ROYAL EMPIRE",
    status: "online"
  });
});

// Data profil pengguna
app.get("/api/profile", verifyUser, async (req, res) => {
  try {
    const ref = db.collection("users").doc(req.user.uid);
    const snapshot = await ref.get();

    if (!snapshot.exists) {
      await ref.set({
        uid: req.user.uid,
        email: req.user.email || "",
        fullName: "",
        role: "user",
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    const updated = await ref.get();
    const data = updated.data();

    res.json({
      success: true,
      profile: {
        uid: req.user.uid,
        email: req.user.email || "",
        fullName: data.fullName || "",
        role: data.role || "user"
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Gagal mengambil profil"
    });
  }
});

// Buat permintaan deposit
app.post("/api/deposits", verifyUser, async (req, res) => {
  try {
    const amount = Number(req.body.amount);
    const method = String(req.body.method || "").trim();

    if (!Number.isSafeInteger(amount) || amount < 10000) {
      return res.status(400).json({
        success: false,
        message: "Minimal deposit Rp10.000"
      });
    }

    if (!["bank_transfer", "e_wallet"].includes(method)) {
      return res.status(400).json({
        success: false,
        message: "Metode deposit tidak valid"
      });
    }

    const ref = await db.collection("deposits").add({
      uid: req.user.uid,
      amount,
      method,
      status: "pending",
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({
      success: true,
      message: "Permintaan deposit berhasil dibuat",
      depositId: ref.id
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Gagal membuat permintaan deposit"
    });
  }
});

// Riwayat deposit
app.get("/api/deposits", verifyUser, async (req, res) => {
  try {
    const snapshot = await db.collection("deposits")
      .where("uid", "==", req.user.uid)
      .limit(100)
      .get();

    res.json({
      success: true,
      deposits: snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }))
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Gagal mengambil riwayat deposit"
    });
  }
});

// Buat permintaan penarikan
app.post("/api/withdrawals", verifyUser, async (req, res) => {
  try {
    const amount = Number(req.body.amount);
    const accountId = String(req.body.accountId || "").trim();

    if (!Number.isSafeInteger(amount) || amount < 10000) {
      return res.status(400).json({
        success: false,
        message: "Minimal penarikan Rp10.000"
      });
    }

    if (!accountId) {
      return res.status(400).json({
        success: false,
        message: "Rekening tujuan harus dipilih"
      });
    }

    const account = await db.collection("payout_accounts")
      .doc(accountId)
      .get();

    if (!account.exists || account.data().uid !== req.user.uid) {
      return res.status(400).json({
        success: false,
        message: "Rekening tujuan tidak valid"
      });
    }

    const ref = await db.collection("withdrawals").add({
      uid: req.user.uid,
      amount,
      accountId,
      status: "pending",
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({
      success: true,
      message: "Permintaan penarikan berhasil dibuat",
      withdrawalId: ref.id
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Gagal membuat permintaan penarikan"
    });
  }
});

// Daftar rekening pengguna
app.get("/api/accounts", verifyUser, async (req, res) => {
  try {
    const snapshot = await db.collection("payout_accounts")
      .where("uid", "==", req.user.uid)
      .get();

    res.json({
      success: true,
      accounts: snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }))
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Gagal mengambil rekening"
    });
  }
});

// Tambah rekening tujuan
app.post("/api/accounts", verifyUser, async (req, res) => {
  try {
    const bank = String(req.body.bank || "").trim();
    const accountName = String(req.body.accountName || "").trim();
    const accountNumber = String(req.body.accountNumber || "").trim();

    if (!bank || !accountName || !accountNumber) {
      return res.status(400).json({
        success: false,
        message: "Data rekening belum lengkap"
      });
    }

    if (accountNumber.length < 5 || accountNumber.length > 30) {
      return res.status(400).json({
        success: false,
        message: "Nomor rekening tidak valid"
      });
    }

    const ref = await db.collection("payout_accounts").add({
      uid: req.user.uid,
      bank,
      accountName,
      accountNumber,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({
      success: true,
      accountId: ref.id
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Gagal menyimpan rekening"
    });
  }
});

// Admin: lihat permintaan deposit
app.get("/api/admin/deposits", verifyUser, verifyAdmin, async (req, res) => {
  try {
    const snapshot = await db.collection("deposits")
      .where("status", "==", "pending")
      .limit(100)
      .get();

    res.json({
      success: true,
      deposits: snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }))
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Gagal mengambil data deposit"
    });
  }
});

// Admin: verifikasi deposit
app.post("/api/admin/deposits/:id/approve",
  verifyUser, verifyAdmin, async (req, res) => {
    try {
      const depositRef = db.collection("deposits").doc(req.params.id);

      await db.runTransaction(async transaction => {
        const deposit = await transaction.get(depositRef);

        if (!deposit.exists || deposit.data().status !== "pending") {
          throw new Error("Deposit tidak tersedia atau sudah diproses");
        }

        const data = deposit.data();
        const walletRef = db.collection("wallets").doc(data.uid);
        const wallet = await transaction.get(walletRef);

        const currentBalance = wallet.exists
          ? Number(wallet.data().balance || 0)
          : 0;

        transaction.set(walletRef, {
          balance: currentBalance + data.amount,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        transaction.update(depositRef, {
          status: "approved",
          reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
          reviewedBy: req.user.uid
        });

        const ledgerRef = db.collection("wallet_ledger").doc();

        transaction.set(ledgerRef, {
          uid: data.uid,
          type: "deposit",
          amount: data.amount,
          referenceId: depositRef.id,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
      });

      res.json({
        success: true,
        message: "Deposit disetujui"
      });
    } catch (error) {
      res.status(400).json({
        success: false,
        message: error.message
      });
    }
  }
);

// Admin: lihat permintaan penarikan
app.get("/api/admin/withdrawals", verifyUser, verifyAdmin, async (req, res) => {
  try {
    const snapshot = await db.collection("withdrawals")
      .where("status", "==", "pending")
      .limit(100)
      .get();

    res.json({
      success: true,
      withdrawals: snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }))
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Gagal mengambil penarikan"
    });
  }
});

// Admin: tandai penarikan telah dibayar setelah transfer benar-benar dilakukan
app.post("/api/admin/withdrawals/:id/paid",
  verifyUser, verifyAdmin, async (req, res) => {
    try {
      const withdrawalRef = db.collection("withdrawals").doc(req.params.id);

      await db.runTransaction(async transaction => {
        const withdrawal = await transaction.get(withdrawalRef);

        if (!withdrawal.exists || withdrawal.data().status !== "pending") {
          throw new Error("Penarikan tidak tersedia atau sudah diproses");
        }

        const data = withdrawal.data();
        const walletRef = db.collection("wallets").doc(data.uid);
        const wallet = await transaction.get(walletRef);

        const balance = wallet.exists
          ? Number(wallet.data().balance || 0)
          : 0;

        if (balance < data.amount) {
          throw new Error("Saldo tidak mencukupi");
        }

        transaction.update(walletRef, {
          balance: balance - data.amount,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        transaction.update(withdrawalRef, {
          status: "paid",
          reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
          reviewedBy: req.user.uid
        });

        const ledgerRef = db.collection("wallet_ledger").doc();

        transaction.set(ledgerRef, {
          uid: data.uid,
          type: "withdrawal",
          amount: -data.amount,
          referenceId: withdrawalRef.id,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
      });

      res.json({
        success: true,
        message: "Penarikan dicatat sebagai sudah dibayar"
      });
    } catch (error) {
      res.status(400).json({
        success: false,
        message: error.message
      });
    }
  }
);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`ROYAL EMPIRE server berjalan di port ${PORT}`);
});
