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