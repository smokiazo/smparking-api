const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const bcrypt = require('bcrypt');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

/**
 * Database Connection Pool
 * Optimized for TiDB on Render.com
 */
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT,
    ssl: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
    waitForConnections: true,
    connectionLimit: 10,
    multipleStatements: true // Required for multi-update during check-in
});

// TEST ROUTE: Check if the bridge is alive
app.get('/', (req, res) => res.send("SMPARKING Bridge is Running"));

/**
 * 1. REGISTER: Add user to TiDB 'Users' table
 * Matches SignupActivity.java logic (hashes in app)
 */
app.post('/register', (req, res) => {
    const { user_fullname, user_email, user_phone, password } = req.body;

    // The Android app already hashes the password using BCrypt before sending.
    // We store the 'password' field directly into 'passwordHASH' column.
    const sql = "INSERT INTO Users (user_fullname, user_email, user_phone, passwordHASH) VALUES (?, ?, ?, ?)";

    pool.query(sql, [user_fullname, user_email, user_phone, password], (err, result) => {
        if (err) {
            console.error("Signup Error:", err);
            return res.status(500).json({ success: false, message: "Registration failed: " + err.message });
        }
        res.json({ success: true, message: "Account created successfully" });
    });
});

/**
 * 2. LOGIN: Match data in 'Users' table
 * Matches MainActivity.java (sends plain text password)
 */
app.post('/login', (req, res) => {
    const { user_email, password } = req.body;
    const sql = "SELECT * FROM Users WHERE user_email = ?";

    pool.query(sql, [user_email], async (err, results) => {
        if (err) return res.status(500).json({ success: false, message: err.message });

        if (results.length > 0) {
            const user = results[0];
            // Compare plain text 'password' with 'passwordHASH' from TiDB
            try {
                const match = await bcrypt.compare(password, user.passwordHASH);
                if (match) {
                    delete user.passwordHASH; // Security: remove hash before sending
                    res.json({ success: true, user: user });
                } else {
                    res.json({ success: false, message: "Invalid email or password" });
                }
            } catch (bcryptErr) {
                res.status(500).json({ success: false, message: "Auth Error" });
            }
        } else {
            res.json({ success: false, message: "Account not found" });
        }
    });
});

/**
 * 3. CHECK-IN: Create transaction and update slot status
 * Matches AssignActivity.java & 'ParkingTransactions' table
 */
app.post('/check-in', (req, res) => {
    const { plate_number, slot_id, user_id, is_pwd } = req.body;

    pool.getConnection((err, conn) => {
        if (err) return res.status(500).json({ error: err.message });

        conn.beginTransaction((err) => {
            if (err) return res.status(500).json({ error: err.message });

            // 1. Insert Transaction into ParkingTransactions
            // FIX: reference_code is NOT NULL in database, so we must provide a temporary unique value
            const tempCode = 'TEMP-' + Date.now();
            const insertSql = "INSERT INTO ParkingTransactions (reference_code, plate_number, slot_id, user_id, is_pwd, entry_time, payment_status) VALUES (?, ?, ?, ?, ?, NOW(), 'UNPAID')";

            conn.query(insertSql, [tempCode, plate_number, slot_id, user_id || null, is_pwd || 0], (err, result) => {
                if (err) return conn.rollback(() => {
                    conn.release();
                    console.error("Insert Error:", err);
                    res.status(500).json({ error: err.message });
                });

                const newId = result.insertId;
                // Requested format: SMCAB-XXXXXX
                const refCode = `SMCAB-${String(newId).padStart(6, '0')}`;

                // 2. Update Reference Code and mark ParkingSlot as Occupied
                const updateSql = "UPDATE ParkingTransactions SET reference_code = ? WHERE transaction_id = ?; UPDATE ParkingSlots SET status = 'OCCUPIED' WHERE slot_id = ?;";

                conn.query(updateSql, [refCode, newId, slot_id], (err) => {
                    if (err) return conn.rollback(() => {
                        conn.release();
                        res.status(500).json({ error: err.message });
                    });

                    conn.commit(() => {
                        conn.release();
                        res.json({ success: true, reference_code: refCode, transaction_id: newId });
                    });
                });
            });
        });
    });
});

/**
 * 4. SUBMIT REPORT: Save issues to 'UserReports' table
 * Matches ReportActivity.java
 */
app.post('/submit-report', (req, res) => {
    const { subject, details } = req.body;
    const sql = "INSERT INTO UserReports (subject, details, status, created_at) VALUES (?, ?, 'PENDING', NOW())";

    pool.query(sql, [subject, details], (err) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        res.json({ success: true, message: "Report submitted" });
    });
});

/**
 * 5. USER HISTORY: Get transactions for 'Dashboard' history list
 */
app.get('/user/:user_id/transactions', (req, res) => {
    const sql = "SELECT * FROM ParkingTransactions WHERE user_id = ? ORDER BY entry_time DESC";
    pool.query(sql, [req.params.user_id], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

/**
 * 6. TRANSACTION DETAILS: Fetch data by reference code
 * Used in 'TransactionActivity'
 */
app.get('/transaction/:reference_code', (req, res) => {
    const sql = "SELECT * FROM ParkingTransactions WHERE reference_code = ?";
    pool.query(sql, [req.params.reference_code], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        if (results.length > 0) res.json(results[0]);
        else res.status(404).json({ message: "Transaction not found" });
    });
});

/**
 * 7. GET SLOTS: Get all parking slots for availability
 */
app.get('/slots', (req, res) => {
    const sql = "SELECT * FROM ParkingSlots";
    pool.query(sql, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
