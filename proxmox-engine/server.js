const express = require('express');
const axios = require('axios');
const cors = require('cors');
const https = require('https');
const mysql = require('mysql2/promise');

const app = express();

app.use(express.json());
app.use(cors());

// ======================================================
// 🗄️ MYSQL
// ======================================================
const db = mysql.createPool({
    host: 'localhost',
    user: 'x',
    password: '1234',
    database: 'proxmox_cloud',
    waitForConnections: true,
    connectionLimit: 10
});

// ======================================================
// 🔐 CONFIG
// ======================================================
const API_KEY = "123456";
const ENGINE_URL = "http://localhost:3000/crear-vm";
const PROXMOX_URL = "https://localhost:8006/api2/json";

// ======================================================
// 🔧 PROVISIONING HELPERS
// ======================================================

function randomMac() {
    return "02:xx:xx:xx:xx:xx".replace(/xx/g, () =>
        Math.floor(Math.random() * 255).toString(16).padStart(2, "0")
    );
}



// 👇 USA TU MISMO TOKEN DEL ENGINE
const PROXMOX_TOKEN_ID = "root@pam!clonador-vm";
const PROXMOX_TOKEN_SECRET = "f8dd16a8-453c-47b1-a0df-6f6b2ad80d90";

const NODE = "Atenea-x";

const httpsAgent = new https.Agent({
    rejectUnauthorized: false
});

// ======================================================
// 🔐 AXIOS PROXMOX CLIENT
// ======================================================
const proxmox = axios.create({
    baseURL: PROXMOX_URL,
    httpsAgent,
    timeout: 15000,
    headers: {
        Authorization:
            `PVEAPIToken=${PROXMOX_TOKEN_ID}=${PROXMOX_TOKEN_SECRET}`
    }
});

// ======================================================
// 🧰 HELPERS
// ======================================================
function log(title, data = "") {
    console.log("\n================================================");
    console.log(title);
    if (data) console.log(data);
    console.log("================================================\n");
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function postProvisionVM(vmid, nombre) {

    console.log("🚀 POST PROVISION START:", vmid);

    try {
        const mac = randomMac();

        // 1. Cambiar nombre VM
        await axios.post(
            `${PROXMOX_URL}/nodes/Atenea-x/qemu/${vmid}/config`,
            { name: nombre },
            { httpsAgent }
        );

        console.log("✅ Name changed:", nombre);

        // 2. Cambiar MAC
        await axios.post(
            `${PROXMOX_URL}/nodes/Atenea-x/qemu/${vmid}/config`,
            {
                net0: `virtio=${mac},bridge=vmbr0`
            },
            { httpsAgent }
        );

        console.log("✅ MAC changed:", mac);

        return { mac };

    } catch (err) {
        console.log("❌ POST PROVISION ERROR:", err.message);
        throw err;
    }
}
// ======================================================
// 🔎 GET REAL STATUS
// ======================================================
async function getVmStatus(vmid) {
    try {
        const res = await proxmox.get(
            `/nodes/${NODE}/qemu/${vmid}/status/current`
        );

        return res.data?.data?.status || "unknown";

    } catch (e) {
        return "missing";
    }
}

// ======================================================
// 🌐 GET REAL IP
// ======================================================
async function getVmIp(vmid, fallback = "N/A") {

    try {

        const res = await proxmox.get(
            `/nodes/${NODE}/qemu/${vmid}/agent/network-get-interfaces`
        );

        const interfaces = res.data?.data?.result || [];

        for (const iface of interfaces) {

            if (!iface["ip-addresses"]) continue;

            for (const ip of iface["ip-addresses"]) {

                if (
                    ip["ip-address-type"] === "ipv4" &&
                    ip["ip-address"] !== "127.0.0.1"
                ) {
                    return ip["ip-address"];
                }
            }
        }

        return fallback;

    } catch (e) {
        return fallback;
    }
}

// ======================================================
// 🚀 CREATE ORDER
// ======================================================
app.post('/create-order', async (req, res) => {

    try {

        if (req.headers['x-api-key'] !== API_KEY) {
            return res.status(403).json({
                ok: false,
                error: "No autorizado"
            });
        }

        const { cpu, ram, disk, nombre } = req.body;

        if (!cpu || !ram || !disk || !nombre) {
            return res.status(400).json({
                ok: false,
                error: "Faltan parámetros"
            });
        }

        const payload = {
            nombre,
            cpu,
            ram,
            disk_size: disk
        };

        log("➡️ CREATE ORDER", payload);

        const response = await axios.post(
            ENGINE_URL,
            payload
        );

        const vm = response.data;

        if (!vm || !vm.vmid) {
            throw new Error("Engine no devolvió VM válida");
        }

        const sshUser = vm.ssh?.user ?? "x";
        const sshPass = vm.ssh?.password ?? "Capitan12";

        const result = {
            ok: true,
            vmid: Number(vm.vmid),
            nombre: vm.nombre,
            hostname: vm.hostname,
            cpu: Number(vm.cpu),
            ram: Number(vm.ram),
            disk_size: Number(vm.disk_size),
            ip: vm.ip || "N/A",
            ssh: {
                user: sshUser,
                password: sshPass
            },
            status: vm.status || "running"
        };

        await db.query(
            `INSERT INTO vms
            (vmid,nombre,hostname,ssh_user,ssh_pass,cpu,ram,disk,status)
            VALUES (?,?,?,?,?,?,?,?,?)`,
            [
                result.vmid,
                result.nombre,
                result.hostname,
                sshUser,
                sshPass,
                result.cpu,
                result.ram,
                result.disk_size,
                result.status
            ]
        );

        res.json(result);

    } catch (error) {

        res.status(500).json({
            ok: false,
            error: error.response?.data || error.message
        });
    }
});

// ======================================================
// 📦 LISTAR VMS REALTIME
// ======================================================
app.get('/vms', async (req, res) => {

    try {

        const [rows] = await db.query(
            "SELECT * FROM vms ORDER BY id DESC"
        );

        const output = [];

        for (const vm of rows) {

            const status = await getVmStatus(vm.vmid);
            const ip = await getVmIp(vm.vmid, vm.ip || "N/A");

            output.push({
                ...vm,
                status,
                ip
            });
        }

        res.json(output);

    } catch (err) {

        res.status(500).json({
            ok: false,
            error: err.message
        });
    }
});

// ======================================================
// 🚀 START VM
// ======================================================
app.post('/vm/start', async (req, res) => {

    const { vmid } = req.body;

    try {

        log("🚀 START VM", vmid);

        await proxmox.post(
            `/nodes/${NODE}/qemu/${vmid}/status/start`
        );

        await db.query(
            "UPDATE vms SET status='running' WHERE vmid=?",
            [vmid]
        );

        await sleep(1000);

        const status = await getVmStatus(vmid);

        res.json({
            ok: true,
            vmid,
            status
        });

    } catch (err) {

        res.status(500).json({
            ok: false,
            error: err.response?.data || err.message
        });
    }
});

// ======================================================
// 🛑 STOP VM
// ======================================================
app.post('/vm/stop', async (req, res) => {

    const { vmid } = req.body;

    try {

        log("🛑 STOP VM", vmid);

        await proxmox.post(
            `/nodes/${NODE}/qemu/${vmid}/status/stop`
        );

        await db.query(
            "UPDATE vms SET status='stopped' WHERE vmid=?",
            [vmid]
        );

        await sleep(1000);

        const status = await getVmStatus(vmid);

        res.json({
            ok: true,
            vmid,
            status
        });

    } catch (err) {

        res.status(500).json({
            ok: false,
            error: err.response?.data || err.message
        });
    }
});

// ======================================================
// 🗑️ DELETE VM
// ======================================================
app.delete('/vm/:vmid', async (req, res) => {

    const vmid = req.params.vmid;

    try {

        log("🗑️ DELETE VM", vmid);

        // intentar parar antes
        try {
            await proxmox.post(
                `/nodes/${NODE}/qemu/${vmid}/status/stop`
            );
            await sleep(1500);
        } catch (e) {}

        // borrar real en proxmox
        try {
            await proxmox.delete(
                `/nodes/${NODE}/qemu/${vmid}`
            );
        } catch (e) {
            log("⚠️ DELETE WARNING", e.response?.data || e.message);
        }

        // borrar mysql SIEMPRE
        await db.query(
            "DELETE FROM vms WHERE vmid=?",
            [vmid]
        );

        res.json({
            ok: true,
            vmid,
            message: "VM eliminada"
        });

    } catch (err) {

        res.status(500).json({
            ok: false,
            error: err.response?.data || err.message
        });
    }
});

// ======================================================
// 🔍 INFO VM EXTRA
// ======================================================
app.get('/vm/:vmid/info', async (req, res) => {

    const vmid = req.params.vmid;

    try {

        const status = await getVmStatus(vmid);
        const ip = await getVmIp(vmid);

        res.json({
            ok: true,
            vmid,
            status,
            ip
        });

    } catch (err) {

        res.status(500).json({
            ok: false,
            error: err.message
        });
    }
});

// ======================================================
// ❤️ HEALTHCHECK
// ======================================================
app.get('/health', async (req, res) => {

    res.json({
        ok: true,
        service: "gateway",
        mysql: "online",
        node: NODE
    });
});

// ======================================================
// 🌐 SERVER
// ======================================================
app.listen(4567, '0.0.0.0', () => {
    console.log("🌐 Gateway activo en http://localhost:4567");
});