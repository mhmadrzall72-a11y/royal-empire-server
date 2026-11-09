const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const path = require("path");
const crypto = require("crypto");

const app = express();

app.use(cors({
  origin: true,
  methods: ["GET", "POST", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.use(express.json({ limit: "1mb" }));
app.use(express.static(__dirname));

if (!admin.apps.length) {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
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
const FieldValue = admin.firestore.FieldValue;
const Timestamp = admin.firestore.Timestamp;

// Katalog paket. Nilai keuntungan dan total bersih dikirim sebagai angka.
// Nilai yang ditampilkan adalah estimasi dan bukan jaminan hasil.
const PACKAGES = {
  paket_1_hari: {
    id: "paket_1_hari", name: "Paket 1 Hari", price: 75000,
    durationDays: 1, profitPercent: 30.6667, profitAmount: 23000,
    totalReturn: 98000, description: "Estimasi nilai akhir paket 1 hari."
  },
  paket_5_hari: {
    id: "paket_5_hari", name: "Paket 5 Hari", price: 250000,
    durationDays: 5, profitPercent: 60, profitAmount: 150000,
    totalReturn: 400000, description: "Estimasi nilai akhir paket 5 hari."
  },
  royal: {
    id: "royal", name: "Royal", price: 800000,
    durationDays: 15, profitPercent: 80, profitAmount: 640000,
    totalReturn: 1440000, description: "Estimasi nilai akhir paket Royal."
  },
  emperor: {
    id: "emperor", name: "Emperor", price: 1500000,
    durationDays: 30, profitPercent: 95, profitAmount: 1425000,
    totalReturn: 2925000, description: "Estimasi nilai akhir paket Emperor."
  }
};

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    app: "ROYAL EMPIRE",
    status: "online"
  });
});

// ===============================
// AUTENTIKASI DAN HAK AKSES
// ===============================

async function verifyUser(req, res, next) {
  try {
    const header = req.headers.authorization || "";

    if (!header.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "Token login tidak ditemukan"
      });
    }

    req.user = await auth.verifyIdToken(header.substring(7));
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
    const userDoc = await db.collection("users")
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

function cleanDocument(doc) {
  return {
    id: doc.id,
    ...doc.data()
  };
}

function errorResponse(res, error, fallback) {
  console.error(fallback, error);
  return res.status(400).json({
    success: false,
    message: error.message || fallback
  });
}

// Normalisasi nomor agar 0812-3456 sama dengan 08123456.
function normalizeAccountNumber(value) {
  return String(value || "").replace(/\D/g, "");
}

// ID indeks tidak menyimpan nomor rekening secara langsung.
function accountIndexId(number) {
  return crypto.createHash("sha256")
    .update(number)
    .digest("hex");
}

// ===============================
// PROFIL DAN SALDO PENGGUNA
// ===============================

app.get("/api/profile", verifyUser, async (req, res) => {
  try {
    const ref = db.collection("users").doc(req.user.uid);
    let snapshot = await ref.get();

    if (!snapshot.exists) {
      await ref.set({
        uid: req.user.uid,
        email: req.user.email || "",
        fullName: req.user.name || "",
        role: "user",
        createdAt: FieldValue.serverTimestamp()
      });

      snapshot = await ref.get();
    }

    const data = snapshot.data();

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
    console.error(error);
    res.status(500).json({
      success: false,
      message: "Gagal mengambil profil"
    });
  }
});

app.get("/api/wallet", verifyUser, async (req, res) => {
  try {
    const wallet = await db.collection("wallets")
      .doc(req.user.uid)
      .get();

    res.json({
      success: true,
      balance: wallet.exists
        ? Number(wallet.data().balance || 0)
        : 0
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: "Gagal mengambil saldo"
    });
  }
});

// ===============================
// DEPOSIT PENGGUNA
// ===============================

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
      createdAt: FieldValue.serverTimestamp()
    });

    res.json({
      success: true,
      message: "Permintaan deposit berhasil dibuat",
      depositId: ref.id
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: "Gagal membuat permintaan deposit"
    });
  }
});

app.get("/api/deposits", verifyUser, async (req, res) => {
  try {
    const snapshot = await db.collection("deposits")
      .where("uid", "==", req.user.uid)
      .limit(100)
      .get();

    res.json({
      success: true,
      deposits: snapshot.docs.map(cleanDocument)
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: "Gagal mengambil riwayat deposit"
    });
  }
});

// ===============================
// PENARIKAN PENGGUNA
// ===============================

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

    const accountRef = db.collection("payout_accounts").doc(accountId);
    const walletRef = db.collection("wallets").doc(req.user.uid);
    const withdrawalRef = db.collection("withdrawals").doc();
    const ledgerRef = db.collection("wallet_ledger").doc();

    await db.runTransaction(async transaction => {
      const account = await transaction.get(accountRef);
      const wallet = await transaction.get(walletRef);

      if (!account.exists || account.data().uid !== req.user.uid) {
        throw new Error("Rekening tujuan tidak valid");
      }

      const balance = wallet.exists
        ? Number(wallet.data().balance || 0)
        : 0;

      if (balance < amount) {
        throw new Error("Saldo tidak mencukupi");
      }

      transaction.set(walletRef, {
        balance: balance - amount,
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });

      transaction.set(withdrawalRef, {
        uid: req.user.uid,
        amount,
        accountId,
        status: "pending",
        fundsReserved: true,
        createdAt: FieldValue.serverTimestamp()
      });

      transaction.set(ledgerRef, {
        uid: req.user.uid,
        type: "withdrawal_reserved",
        amount: -amount,
        referenceId: withdrawalRef.id,
        createdAt: FieldValue.serverTimestamp()
      });
    });

    res.json({
      success: true,
      message: "Permintaan penarikan berhasil dibuat",
      withdrawalId: withdrawalRef.id
    });
  } catch (error) {
    errorResponse(res, error, "Gagal membuat penarikan");
  }
});

app.get("/api/withdrawals", verifyUser, async (req, res) => {
  try {
    const snapshot = await db.collection("withdrawals")
      .where("uid", "==", req.user.uid)
      .limit(100)
      .get();

    res.json({
      success: true,
      withdrawals: snapshot.docs.map(cleanDocument)
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: "Gagal mengambil riwayat penarikan"
    });
  }
});
// ===============================
// REKENING PENCAIRAN
// ===============================

app.get("/api/accounts", verifyUser, async (req, res) => {
  try {
    const snapshot = await db.collection("payout_accounts")
      .where("uid", "==", req.user.uid)
      .get();

    res.json({
      success: true,
      accounts: snapshot.docs.map(cleanDocument)
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: "Gagal mengambil rekening"
    });
  }
});

// Tambah rekening + pemeriksaan nomor duplikat.
app.post("/api/accounts", verifyUser, async (req, res) => {
  try {
    const bank = String(req.body.bank || "").trim();
    const accountName = String(req.body.accountName || "").trim();
    const accountNumber = String(req.body.accountNumber || "").trim();
    const normalized = normalizeAccountNumber(accountNumber);

    if (!bank || !accountName || !accountNumber) {
      return res.status(400).json({
        success: false,
        message: "Data rekening belum lengkap"
      });
    }

    if (normalized.length < 5 || normalized.length > 30) {
      return res.status(400).json({
        success: false,
        message: "Nomor rekening tidak valid"
      });
    }

    const accountsRef = db.collection("payout_accounts");
    const indexRef = db.collection("payout_account_numbers")
      .doc(accountIndexId(normalized));

    // Periksa rekening lama milik pengguna, termasuk data sebelum fitur indeks.
    const oldAccounts = await accountsRef
      .where("uid", "==", req.user.uid)
      .get();

    const alreadyExists = oldAccounts.docs.some(doc => {
      const data = doc.data();
      return normalizeAccountNumber(
        data.accountNumberNormalized || data.accountNumber
      ) === normalized;
    });

    if (alreadyExists) {
      return res.status(409).json({
        success: false,
        message: "Rekening sudah terdaftar."
      });
    }

    const ref = accountsRef.doc();

    await db.runTransaction(async transaction => {
      const index = await transaction.get(indexRef);

      if (index.exists) {
        throw new Error("Rekening sudah terdaftar.");
      }

      transaction.set(ref, {
        uid: req.user.uid,
        bank,
        accountName,
        accountNumber,
        accountNumberNormalized: normalized,
        createdAt: FieldValue.serverTimestamp()
      });

      transaction.set(indexRef, {
        uid: req.user.uid,
        accountId: ref.id,
        createdAt: FieldValue.serverTimestamp()
      });
    });

    res.json({
      success: true,
      message: "Rekening berhasil disimpan",
      accountId: ref.id
    });
  } catch (error) {
    if (error.message === "Rekening sudah terdaftar.") {
      return res.status(409).json({
        success: false,
        message: error.message
      });
    }

    console.error(error);
    res.status(500).json({
      success: false,
      message: "Gagal menyimpan rekening"
    });
  }
});

// Hapus rekening milik pengguna yang sedang login.
app.delete("/api/accounts/:id", verifyUser, async (req, res) => {
  try {
    const accountId = String(req.params.id || "").trim();

    if (!accountId) {
      return res.status(400).json({
        success: false,
        message: "ID rekening tidak valid"
      });
    }

    const accountRef = db.collection("payout_accounts").doc(accountId);

    await db.runTransaction(async transaction => {
      const account = await transaction.get(accountRef);

      if (!account.exists || account.data().uid !== req.user.uid) {
        throw new Error("Rekening tidak ditemukan.");
      }

      const pending = await db.collection("withdrawals")
        .where("accountId", "==", accountId)
        .where("status", "==", "pending")
        .limit(1)
        .get();

      if (!pending.empty) {
        throw new Error(
          "Rekening sedang digunakan pengajuan penarikan. Coba lagi setelah diproses."
        );
      }

      const data = account.data();
      const normalized = normalizeAccountNumber(
        data.accountNumberNormalized || data.accountNumber
      );

      if (normalized) {
        const indexRef = db.collection("payout_account_numbers")
          .doc(accountIndexId(normalized));

        const index = await transaction.get(indexRef);

        if (index.exists && index.data().accountId === accountId) {
          transaction.delete(indexRef);
        }
      }

      transaction.delete(accountRef);
    });

    res.json({
      success: true,
      message: "Rekening berhasil dihapus."
    });
  } catch (error) {
    const message = error.message || "";

    if (
      message === "Rekening tidak ditemukan." ||
      message.startsWith("Rekening sedang digunakan")
    ) {
      return res.status(400).json({
        success: false,
        message
      });
    }

    console.error(error);
    res.status(500).json({
      success: false,
      message: "Gagal menghapus rekening"
    });
  }
});

// ===============================
// PAKET INVESTASI
// ===============================

app.get("/api/packages", verifyUser, (req, res) => {
  res.json({
    success: true,
    packages: Object.values(PACKAGES).map(p => ({
      ...p,
      profitAmount: Number(p.profitAmount),
      totalReturn: Number(p.totalReturn)
    }))
  });
});

app.get("/api/packages/mine", verifyUser, async (req, res) => {
  try {
    const snap = await db.collection("package_purchases")
      .where("uid", "==", req.user.uid)
      .limit(100)
      .get();

    const packages = snap.docs.map(doc => {
      const purchase = cleanDocument(doc);
      const config = PACKAGES[purchase.packageId] || {};

      const profitAmount =
        Number(purchase.profitAmount) ||
        Number(config.profitAmount) ||
        0;

      const totalReturn =
        Number(purchase.totalReturn) ||
        Number(config.totalReturn) ||
        (Number(purchase.purchaseAmount || 0) + profitAmount);

      return {
        ...purchase,
        profitAmount,
        totalReturn
      };
    });

    res.json({
      success: true,
      packages
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: "Gagal mengambil paket pengguna"
    });
  }
});

app.post("/api/packages/purchase", verifyUser, async (req, res) => {
  try {
    const selected = PACKAGES[String(req.body.packageId || "")];

    if (!selected) {
      return res.status(400).json({
        success: false,
        message: "Paket tidak tersedia."
      });
    }

    const walletRef = db.collection("wallets").doc(req.user.uid);
    const purchaseRef = db.collection("package_purchases").doc();
    const ledgerRef = db.collection("wallet_ledger").doc();

    await db.runTransaction(async transaction => {
      const wallet = await transaction.get(walletRef);
      const balance = wallet.exists
        ? Number(wallet.data().balance || 0)
        : 0;

      if (
        !Number.isSafeInteger(balance) ||
        balance < selected.price
      ) {
        throw new Error("Saldo tidak mencukupi untuk membeli paket.");
      }

      const now = new Date();
      const maturity = new Date(
        now.getTime() + selected.durationDays * 86400000
      );

      transaction.set(walletRef, {
        balance: balance - selected.price,
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });

      transaction.set(purchaseRef, {
        uid: req.user.uid,
        packageId: selected.id,
        packageName: selected.name,
        purchaseAmount: selected.price,
        durationDays: selected.durationDays,
        profitPercent: Number(selected.profitPercent),
        profitAmount: Number(selected.profitAmount),
        totalReturn: Number(selected.totalReturn),
        status: "active",
        purchasedAt: Timestamp.fromDate(now),
        maturityAt: Timestamp.fromDate(maturity),
        createdAt: FieldValue.serverTimestamp()
      });

      transaction.set(ledgerRef, {
        uid: req.user.uid,
        type: "package_purchase",
        amount: -selected.price,
        referenceId: purchaseRef.id,
        createdAt: FieldValue.serverTimestamp()
      });
    });

    res.json({
      success: true,
      message: "Paket berhasil dibeli dan masa paket sudah dimulai.",
      purchaseId: purchaseRef.id
    });
  } catch (error) {
    errorResponse(res, error, "Gagal membeli paket");
  }
});

app.post("/api/support", verifyUser, async (req, res) => {
  try {
    const message = String(req.body.message || "").trim();

    if (!message || message.length > 2000) {
      return res.status(400).json({
        success: false,
        message: "Pesan wajib diisi dan maksimal 2.000 karakter."
      });
    }

    await db.collection("support_messages").add({
      uid: req.user.uid,
      email: req.user.email || "",
      message,
      status: "open",
      createdAt: FieldValue.serverTimestamp()
    });

    res.json({
      success: true,
      message: "Pesan bantuan berhasil dikirim."
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: "Gagal mengirim pesan bantuan."
    });
  }
});

// ===============================
// ADMIN: RINGKASAN DASHBOARD
// ===============================

app.get("/api/admin/overview",
  verifyUser, verifyAdmin, async (req, res) => {
    try {
      const [users, wallets, deposits, withdrawals] = await Promise.all([
        db.collection("users").get(),
        db.collection("wallets").get(),
        db.collection("deposits").where("status", "==", "pending").get(),
        db.collection("withdrawals").where("status", "==", "pending").get()
      ]);

      let totalBalance = 0;

      wallets.docs.forEach(doc => {
        totalBalance += Number(doc.data().balance || 0);
      });

      res.json({
        success: true,
        overview: {
          totalUsers: users.size,
          totalRecordedBalance: totalBalance,
          pendingDeposits: deposits.size,
          pendingWithdrawals: withdrawals.size
        }
      });
    } catch (error) {
      console.error(error);
      res.status(500).json({
        success: false,
        message: "Gagal mengambil ringkasan admin"
      });
    }
  }
);

// ===============================
// ADMIN: DAFTAR DEPOSIT
// ===============================

app.get("/api/admin/deposits",
  verifyUser, verifyAdmin, async (req, res) => {
    try {
      const snapshot = await db.collection("deposits")
        .where("status", "==", "pending")
        .limit(100)
        .get();

      const deposits = await Promise.all(snapshot.docs.map(async doc => {
        const data = cleanDocument(doc);
        const user = await db.collection("users").doc(data.uid).get();

        return {
          ...data,
          userName: user.exists ? user.data().fullName || "" : "",
          userEmail: user.exists ? user.data().email || "" : ""
        };
      }));

      res.json({
        success: true,
        deposits
      });
    } catch (error) {
      console.error(error);
      res.status(500).json({
        success: false,
        message: "Gagal mengambil data deposit"
      });
    }
  }
);

// ===============================
// ADMIN: SETUJUI DEPOSIT
// ===============================

app.post("/api/admin/deposits/:id/approve",
  verifyUser, verifyAdmin, async (req, res) => {
    try {
      const depositRef = db.collection("deposits").doc(req.params.id);
      const ledgerRef = db.collection("wallet_ledger").doc();

      await db.runTransaction(async transaction => {
        const deposit = await transaction.get(depositRef);

        if (!deposit.exists || deposit.data().status !== "pending") {
          throw new Error("Deposit tidak tersedia atau sudah diproses");
        }

        const data = deposit.data();
        const amount = Number(data.amount);

        if (!Number.isSafeInteger(amount) || amount < 10000) {
          throw new Error("Nominal deposit tidak valid");
        }

        const walletRef = db.collection("wallets").doc(data.uid);
        const wallet = await transaction.get(walletRef);

        const balance = wallet.exists
          ? Number(wallet.data().balance || 0)
          : 0;

        transaction.set(walletRef, {
          balance: balance + amount,
          updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });

        transaction.update(depositRef, {
          status: "approved",
          reviewedAt: FieldValue.serverTimestamp(),
          reviewedBy: req.user.uid
        });

        transaction.set(ledgerRef, {
          uid: data.uid,
          type: "deposit",
          amount,
          referenceId: depositRef.id,
          createdAt: FieldValue.serverTimestamp()
        });
      });

      res.json({
        success: true,
        message: "Deposit disetujui"
      });
    } catch (error) {
      errorResponse(res, error, "Gagal menyetujui deposit");
    }
  }
);
// ===============================
// ADMIN: TOLAK DEPOSIT
// ===============================

app.post("/api/admin/deposits/:id/reject",
  verifyUser, verifyAdmin, async (req, res) => {
    try {
      const depositRef = db.collection("deposits").doc(req.params.id);

      await db.runTransaction(async transaction => {
        const deposit = await transaction.get(depositRef);

        if (!deposit.exists || deposit.data().status !== "pending") {
          throw new Error("Deposit tidak tersedia atau sudah diproses");
        }

        transaction.update(depositRef, {
          status: "rejected",
          reviewedAt: FieldValue.serverTimestamp(),
          reviewedBy: req.user.uid
        });
      });

      res.json({
        success: true,
        message: "Deposit ditolak"
      });
    } catch (error) {
      errorResponse(res, error, "Gagal menolak deposit");
    }
  }
);

// ===============================
// ADMIN: DAFTAR PENARIKAN
// ===============================

app.get("/api/admin/withdrawals",
  verifyUser, verifyAdmin, async (req, res) => {
    try {
      const snapshot = await db.collection("withdrawals")
        .where("status", "==", "pending")
        .limit(100)
        .get();

      const withdrawals = await Promise.all(snapshot.docs.map(async doc => {
        const data = cleanDocument(doc);

        const [user, account] = await Promise.all([
          db.collection("users").doc(data.uid).get(),
          db.collection("payout_accounts").doc(data.accountId).get()
        ]);

        return {
          ...data,
          userName: user.exists ? user.data().fullName || "" : "",
          userEmail: user.exists ? user.data().email || "" : "",
          account: account.exists ? {
            bank: account.data().bank || "",
            accountName: account.data().accountName || "",
            accountNumber: account.data().accountNumber || ""
          } : null
        };
      }));

      res.json({
        success: true,
        withdrawals
      });
    } catch (error) {
      console.error(error);
      res.status(500).json({
        success: false,
        message: "Gagal mengambil penarikan"
      });
    }
  }
);

// ===============================
// ADMIN: TANDAI PENARIKAN DIBAYAR
// ===============================

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

        if (data.fundsReserved !== true) {
          const walletRef = db.collection("wallets").doc(data.uid);
          const wallet = await transaction.get(walletRef);

          const balance = wallet.exists
            ? Number(wallet.data().balance || 0)
            : 0;

          if (balance < data.amount) {
            throw new Error("Saldo tidak mencukupi");
          }

          const ledgerRef = db.collection("wallet_ledger").doc();

          transaction.set(walletRef, {
            balance: balance - data.amount,
            updatedAt: FieldValue.serverTimestamp()
          }, { merge: true });

          transaction.set(ledgerRef, {
            uid: data.uid,
            type: "withdrawal",
            amount: -data.amount,
            referenceId: withdrawalRef.id,
            createdAt: FieldValue.serverTimestamp()
          });
        }

        transaction.update(withdrawalRef, {
          status: "paid",
          reviewedAt: FieldValue.serverTimestamp(),
          reviewedBy: req.user.uid
        });
      });

      res.json({
        success: true,
        message: "Penarikan dicatat sebagai sudah dibayar"
      });
    } catch (error) {
      errorResponse(res, error, "Gagal memproses penarikan");
    }
  }
);

// ===============================
// ADMIN: TOLAK PENARIKAN DAN KEMBALIKAN SALDO
// ===============================

app.post("/api/admin/withdrawals/:id/reject",
  verifyUser, verifyAdmin, async (req, res) => {
    try {
      const withdrawalRef = db.collection("withdrawals").doc(req.params.id);

      await db.runTransaction(async transaction => {
        const withdrawal = await transaction.get(withdrawalRef);

        if (!withdrawal.exists || withdrawal.data().status !== "pending") {
          throw new Error("Penarikan tidak tersedia atau sudah diproses");
        }

        const data = withdrawal.data();

        if (data.fundsReserved === true) {
          const walletRef = db.collection("wallets").doc(data.uid);
          const wallet = await transaction.get(walletRef);

          const balance = wallet.exists
            ? Number(wallet.data().balance || 0)
            : 0;

          const ledgerRef = db.collection("wallet_ledger").doc();

          transaction.set(walletRef, {
            balance: balance + data.amount,
            updatedAt: FieldValue.serverTimestamp()
          }, { merge: true });

          transaction.set(ledgerRef, {
            uid: data.uid,
            type: "withdrawal_refund",
            amount: data.amount,
            referenceId: withdrawalRef.id,
            createdAt: FieldValue.serverTimestamp()
          });
        }

        transaction.update(withdrawalRef, {
          status: "rejected",
          reviewedAt: FieldValue.serverTimestamp(),
          reviewedBy: req.user.uid
        });
      });

      res.json({
        success: true,
        message: "Penarikan ditolak dan saldo dikembalikan jika sebelumnya dicadangkan"
      });
    } catch (error) {
      errorResponse(res, error, "Gagal menolak penarikan");
    }
  }
);

// ===============================
// ADMIN: PAKET JATUH TEMPO DAN KREDIT HASIL
// ===============================

app.get("/api/admin/packages/due",
  verifyUser, verifyAdmin, async (req, res) => {
    try {
      const snap = await db.collection("package_purchases")
        .where("status", "==", "active")
        .limit(200)
        .get();

      const due = snap.docs.filter(doc => {
        const t = doc.data().maturityAt;
        return t &&
          typeof t.toMillis === "function" &&
          t.toMillis() <= Date.now();
      });

      const packages = await Promise.all(due.map(async doc => {
        const data = cleanDocument(doc);
        const user = await db.collection("users").doc(data.uid).get();

        return {
          ...data,
          userName: user.exists ? user.data().fullName || "" : "",
          userEmail: user.exists ? user.data().email || "" : ""
        };
      }));

      res.json({
        success: true,
        packages
      });
    } catch (error) {
      console.error(error);
      res.status(500).json({
        success: false,
        message: "Gagal mengambil paket jatuh tempo."
      });
    }
  }
);

app.post("/api/admin/packages/:id/settle",
  verifyUser, verifyAdmin, async (req, res) => {
    try {
      const purchaseRef = db.collection("package_purchases")
        .doc(req.params.id);

      const ledgerRef = db.collection("wallet_ledger").doc();

      await db.runTransaction(async transaction => {
        const purchase = await transaction.get(purchaseRef);

        if (
          !purchase.exists ||
          purchase.data().status !== "active"
        ) {
          throw new Error("Paket tidak tersedia atau sudah diproses.");
        }

        const data = purchase.data();
        const maturity = data.maturityAt;

        if (
          !maturity ||
          typeof maturity.toMillis !== "function" ||
          maturity.toMillis() > Date.now()
        ) {
          throw new Error("Paket belum jatuh tempo.");
        }

        const amount = Number(data.totalReturn);

        if (!Number.isSafeInteger(amount) || amount <= 0) {
          throw new Error("Nilai hasil paket tidak valid.");
        }

        const walletRef = db.collection("wallets").doc(data.uid);
        const wallet = await transaction.get(walletRef);

        const balance = wallet.exists
          ? Number(wallet.data().balance || 0)
          : 0;

        transaction.set(walletRef, {
          balance: balance + amount,
          updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });

        transaction.update(purchaseRef, {
          status: "settled",
          settledAt: FieldValue.serverTimestamp(),
          settledBy: req.user.uid
        });

        transaction.set(ledgerRef, {
          uid: data.uid,
          type: "package_maturity",
          amount,
          referenceId: purchaseRef.id,
          createdAt: FieldValue.serverTimestamp()
        });
      });

      res.json({
        success: true,
        message: "Hasil paket dikreditkan ke saldo pengguna."
      });
    } catch (error) {
      errorResponse(res, error, "Gagal mengkreditkan hasil paket");
    }
  }
);

app.get("/api/admin/support",
  verifyUser, verifyAdmin, async (req, res) => {
    try {
      const snap = await db.collection("support_messages")
        .where("status", "==", "open")
        .limit(100)
        .get();

      res.json({
        success: true,
        messages: snap.docs.map(cleanDocument)
      });
    } catch (error) {
      console.error(error);
      res.status(500).json({
        success: false,
        message: "Gagal mengambil pesan bantuan."
      });
    }
  }
);

// ===============================
// JALANKAN SERVER
// ===============================

app.listen(PORT, "0.0.0.0", () => {
  console.log(`ROYAL EMPIRE server berjalan di port ${PORT}`);
});
