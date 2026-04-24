const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
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

// TEST ROUTE: Check if the bridge is alive
app.get('/', (req, res) => res.send("SMPARKING Bridge is Running"));

// REGISTER: Add user to TiDB
app.post('/register', (req, res) => {
    const { user_fullname, user_email, user_phone, password } = req.body;
    const sql = "INSERT INTO Users (user_fullname, user_email, user_phone, passwordHASH) VALUES (?, ?, ?, ?)";
    // Note: You should hash the password here for security
    pool.query(sql, [user_fullname, user_email, user_phone, password], (err, result) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        res.json({ success: true, message: "User registered successfully" });
    });
});

// LOGIN: Match user data
app.post('/login', (req, res) => {
    const { user_email, password } = req.body;
    const sql = "SELECT * FROM Users WHERE user_email = ? AND passwordHASH = ?";
    pool.query(sql, [user_email, password], (err, results) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        if (results.length > 0) {
            res.json({ success: true, user: results[0] });
        } else {
            res.json({ success: false, message: "Invalid email or password" });
        }
    });
});

// Install bcrypt: npm install bcrypt
const bcrypt = require('bcrypt');

// UPDATED LOGIN ROUTE
app.post('/login', (req, res) => {
    const { user_email, password } = req.body;
    const sql = "SELECT * FROM Users WHERE user_email = ?";
    
    pool.query(sql, [user_email], async (err, results) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        
        if (results.length > 0) {
            const user = results[0];
            // Match the plain text password with the stored hash
            const match = await bcrypt.compare(password, user.passwordHASH);
            
            if (match) {
                res.json({ success: true, user: user });
            } else {
                res.json({ success: false, message: "Invalid email or password" });
            }
        } else {
            res.json({ success: false, message: "Invalid email or password" });
        }
    });
});

// CHECK-IN: Create transaction and generate SM-CAB code
app.post('/check-in', (req, res) => {
    const { plate_number, slot_id, user_id, is_pwd } = req.body;

    pool.getConnection((err, conn) => {
        if (err) return res.status(500).json({ error: err.message });

        conn.beginTransaction((err) => {
            if (err) return res.status(500).json({ error: err.message });

            // 1. Insert Transaction
            const insertSql = `INSERT INTO ParkingTransactions (plate_number, slot_id, user_id, is_pwd, entry_time, payment_status) VALUES (?, ?, ?, ?, NOW(), 'UNPAID')`;
            
            conn.query(insertSql, [plate_number, slot_id, user_id || null, is_pwd || 0], (err, result) => {
                if (err) return conn.rollback(() => res.status(500).json({ error: err.message }));

                const newId = result.insertId;
                const refCode = `SM-CAB-${String(newId).padStart(6, '0')}`;

                // 2. Update Reference Code and Slot Status
                const updateSql = `
                    UPDATE ParkingTransactions SET reference_code = ? WHERE transaction_id = ?;
                    UPDATE ParkingSlots SET status = 'Occupied' WHERE slot_id = ?;
                `;

                conn.query(updateSql, [refCode, newId, slot_id], (err) => {
                    if (err) return conn.rollback(() => res.status(500).json({ error: err.message }));

                    conn.commit(() => {
                        conn.release();
                        res.json({ success: true, reference_code: refCode, transaction_id: newId });
                    });
                });
            });
        });
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
