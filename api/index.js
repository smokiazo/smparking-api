const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const bcrypt = require('bcrypt');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Database Connection Poo
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

// 0. DEBUG: Test DB Connection and Schema
app.get('/test-db', (req, res) => {
    pool.query("SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ?", [process.env.DB_NAME], (err, results) => {
        if (err) return res.status(500).json({ success: false, error: err.message, stack: err.stack });
        res.json({ success: true, message: "Connection Healthy", schema: results });
    });
});

// 1. REGISTER
app.post('/register', (req, res) => {
    const { user_fullname, user_email, user_phone, password } = req.body;

    // 1. Check if the email is already in use
    const checkUserSql = "SELECT user_id FROM Users WHERE user_email = ?";
    
    pool.query(checkUserSql, [user_email], async (err, results) => {
        if (err) return res.status(500).json({ success: false, message: err.message });

        // If results length is > 0, the email is already registered
        if (results.length > 0) {
            return res.status(409).json({ 
                success: false, 
                message: "An account with this email already exists." 
            });
        }

        try {
            // 2. Hash the password before saving (Fixes login compatibility)
            const saltRounds = 10;
            const hashedPassword = await bcrypt.hash(password, saltRounds);

            // 3. Insert the new user
            const insertSql = "INSERT INTO Users (user_fullname, user_email, user_phone, passwordHASH) VALUES (?, ?, ?, ?)";
            
            pool.query(insertSql, [user_fullname, user_email, user_phone, hashedPassword], (insertErr) => {
                if (insertErr) return res.status(500).json({ success: false, message: insertErr.message });
                
                res.status(201).json({ success: true, message: "Account created successfully" });
            });
        } catch (hashError) {
            console.error("Hashing Error:", hashError);
            res.status(500).json({ success: false, message: "Error securing password." });
        }
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

// 3. CHECK-IN: Create transaction (Slot ID assigned later by Admin)
app.post('/check-in', (req, res) => {
    const { plate_number, vehicle_type, user_id, is_pwd } = req.body;

    // Check for active transaction (where exit_time is NULL)
    const checkSql = "SELECT * FROM ParkingTransactions WHERE user_id = ? AND exit_time IS NULL";
    pool.query(checkSql, [user_id], (err, results) => {
        if (err) return res.status(500).json({ success: false, error: err.message });

        if (results.length > 0) {
            return res.status(400).json({
                success: false,
                message: "You have an active parking session. Please check out before starting a new one."
            });
        }

        // Generate code manually before insert to satisfy NOT NULL constraint
        const refCode = `SMCAB-${Math.floor(100000 + Math.random() * 900000)}`;

        // NOTE: slot_id is left as NULL because the Admin app will assign it later
        // FIX: Fixed syntax error by matching placeholders to columns
        const sql = "INSERT INTO ParkingTransactions (reference_code, plate_number, vehicle_type, user_id, is_pwd, entry_time, payment_status, fee_amount) VALUES (?, ?, ?, ?, ?, NOW(), 'UNPAID', 50.00)";

        pool.query(sql, [refCode, plate_number, vehicle_type || '4-Wheeler', user_id || null, is_pwd || 0], (err, result) => {
            if (err) {
                console.error("Check-in Error:", err.message);
                return res.status(500).json({ success: false, error: err.message });
            }

            res.json({ success: true, reference_code: refCode, transaction_id: result.insertId });
        });
    });
});

// 4. PAY TRANSACTION (Simulated)
app.post('/pay', (req, res) => {
    const { reference_code } = req.body;
    const sql = "UPDATE ParkingTransactions SET payment_status = 'PAID' WHERE reference_code = ?";
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
 * 7. SUBMIT REPORT: Save issues to UserReports table
 */
app.post('/submit-report', (req, res) => {
    const { subject, details } = req.body;
    // status and created_at have default values in DB
    const sql = "INSERT INTO UserReports (subject, details) VALUES (?, ?)";

    pool.query(sql, [subject, details], (err) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        res.json({ success: true, message: "Report submitted successfully" });
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

module.exports = app;
