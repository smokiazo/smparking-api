const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const bcrypt = require('bcrypt');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Database Connection Pool
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT,
    ssl: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
    waitForConnections: true,
    connectionLimit: 10
});

// Root Route
app.get('/', (req, res) => res.send("SMPARKING Bridge is Running"));

// 1. REGISTER
app.post('/register', (req, res) => {
    const { user_fullname, user_email, user_phone, password } = req.body;
    const sql = "INSERT INTO Users (user_fullname, user_email, user_phone, passwordHASH) VALUES (?, ?, ?, ?)";
    pool.query(sql, [user_fullname, user_email, user_phone, password], (err) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        res.json({ success: true, message: "Account created successfully" });
    });
});

// 2. LOGIN
app.post('/login', (req, res) => {
    const { user_email, password } = req.body;
    const sql = "SELECT * FROM Users WHERE user_email = ?";
    pool.query(sql, [user_email], async (err, results) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        if (results.length > 0) {
            const user = results[0];
            const isMatch = await bcrypt.compare(password, user.passwordHASH);
            if (isMatch) {
                delete user.passwordHASH;
                res.json({ success: true, user: user });
            } else {
                res.json({ success: false, message: "Invalid email or password" });
            }
        } else {
            res.json({ success: false, message: "Account not found" });
        }
    });
});

// 3. CHECK-IN (Simplified to avoid 500 error)
app.post('/check-in', (req, res) => {
    const { plate_number, slot_id, user_id, is_pwd } = req.body;

    // Generate code manually before insert to satisfy NOT NULL constraint
    const refCode = `SMCAB-${Math.floor(100000 + Math.random() * 900000)}`;

    const sql = "INSERT INTO ParkingTransactions (reference_code, plate_number, slot_id, user_id, is_pwd, entry_time, payment_status, fee_amount) VALUES (?, ?, ?, ?, ?, NOW(), 'UNPAID', 50.00)";

    pool.query(sql, [refCode, plate_number, slot_id, user_id || null, is_pwd || 0], (err, result) => {
        if (err) {
            console.error("Check-in Error:", err.message);
            return res.status(500).json({ success: false, error: err.message });
        }

        // Update slot status
        pool.query("UPDATE ParkingSlots SET status = 'Occupied' WHERE slot_id = ?", [slot_id]);

        res.json({ success: true, reference_code: refCode, transaction_id: result.insertId });
    });
});

// 4. PAY TRANSACTION (Simulated)
app.post('/pay', (req, res) => {
    const { reference_code } = req.body;
    const sql = "UPDATE ParkingTransactions SET payment_status = 'PAID', exit_time = NOW() WHERE reference_code = ?";
    pool.query(sql, [reference_code], (err, result) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.json({ success: true, message: "Payment successful" });
    });
});

// 5. GET HISTORY
app.get('/user/:user_id/transactions', (req, res) => {
    const sql = "SELECT * FROM ParkingTransactions WHERE user_id = ? ORDER BY entry_time DESC";
    pool.query(sql, [req.params.user_id], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

// 6. GET TRANSACTION DETAILS
app.get('/transaction/:reference_code', (req, res) => {
    const sql = "SELECT * FROM ParkingTransactions WHERE reference_code = ?";
    pool.query(sql, [req.params.reference_code], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        if (results.length > 0) res.json(results[0]);
        else res.status(404).json({ message: "Not found" });
    });
});

/**
 * 8. UPDATE PROFILE: Update user details in TiDB
 */
app.post('/update-profile', (req, res) => {
    const { user_id, user_fullname, user_email, user_phone } = req.body;
    const sql = "UPDATE Users SET user_fullname = ?, user_email = ?, user_phone = ? WHERE user_id = ?";

    pool.query(sql, [user_fullname, user_email, user_phone, user_id], (err, result) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        if (result.affectedRows > 0) {
            res.json({ success: true, message: "Profile updated successfully" });
        } else {
            res.status(404).json({ success: false, message: "User not found" });
        }
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
