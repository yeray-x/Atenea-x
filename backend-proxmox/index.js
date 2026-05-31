const express = require('express');
const axios = require('axios');
const cors = require('cors');
const https = require('https');

const app = express();
app.use(express.json());
app.use(cors());

// ======================================================
// 🔐 PROXMOX CONFIG
// ======================================================
const PROXMOX_URL = 'https://127.0.0.1:8006';
const TOKEN = 'PVEAPIToken=root@pam!clonador-vm=f8dd16a8-453c-47b1-a0df-6f6b2ad80d90';
const NODE = 'Atenea-x';
const TEMPLATE_ID = 100;
const STORAGE = 'Maquinas-Virtuales';

const httpsAgent = new https.Agent({
    rejectUnauthorized: false
});

// ======================================================
// ⏱ UTIL
// ======================================================
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function log(tag, msg) {
    console.log(`\n[${tag}] ${msg}`);
}

// ======================================================
// 🔥 WAIT TASK
// ======================================================
async function esperarTarea(upid) {

    const MAX = 120;
    const INTERVAL = 3000;

    for (let i = 0; i < MAX; i++) {

        try {
            const resp = await axios.get(
                `${PROXMOX_URL}/api2/json/nodes/${NODE}/tasks/${encodeURIComponent(upid)}/status`,
                { headers: { Authorization: TOKEN }, httpsAgent }
            );

            const status = resp?.data?.data?.status;

            if (status === "stopped") {
                log("TASK", "Clonación completada");
                return;
            }

        } catch {}

        await sleep(INTERVAL);
    }

    throw new Error("Timeout clonación");
}

// ======================================================
// 🌐 OBTENER IP (SAFE + RETRY)
// ======================================================
async function obtenerIP(vmid) {

    const MAX = 30;
    const INTERVAL = 5000;

    for (let i = 0; i < MAX; i++) {

        try {
            const resp = await axios.get(
                `${PROXMOX_URL}/api2/json/nodes/${NODE}/qemu/${vmid}/agent/network-get-interfaces`,
                { headers: { Authorization: TOKEN }, httpsAgent }
            );

            const interfaces = resp?.data?.data?.result || [];

            for (const iface of interfaces) {
                for (const ip of iface["ip-addresses"] || []) {
                    if (
                        ip["ip-address-type"] === "ipv4" &&
                        ip["ip-address"] !== "127.0.0.1"
                    ) {
                        return ip["ip-address"];
                    }
                }
            }

        } catch {
            log("IP", `Intento ${i + 1}/${MAX}`);
        }

        await sleep(INTERVAL);
    }

    return "N/A";
}

// ======================================================
// 🚀 CREATE VM
// ======================================================
app.post('/crear-vm', async (req, res) => {

    try {

        const { nombre, cpu, ram, disk_size } = req.body;

        if (!nombre || !cpu || !ram || !disk_size) {
            return res.status(400).json({ error: "Faltan parámetros" });
        }

        log("REQUEST", JSON.stringify(req.body));

        // ==================================================
        // 🆔 VMID
        // ==================================================
        const nextIdResp = await axios.get(
            `${PROXMOX_URL}/api2/json/cluster/nextid`,
            { headers: { Authorization: TOKEN }, httpsAgent }
        );

        const vmid = nextIdResp?.data?.data;
        if (!vmid) throw new Error("VMID inválido");

        log("VMID", vmid);

        // ==================================================
        // 🧹 HOSTNAME
        // ==================================================
        const hostname = nombre
            .toLowerCase()
            .replace(/[^a-z0-9-]/g, '-')
            .replace(/-+/g, '-')
            .replace(/^-|-$/g, '');

        // ==================================================
        // 🔐 SSH
        // ==================================================
        const sshUser = "x";
        const sshPass = "Capitan12";

        // ==================================================
        // 📦 CLONE
        // ==================================================
        let upid;

        const cloneResp = await axios.post(
            `${PROXMOX_URL}/api2/json/nodes/${NODE}/qemu/${TEMPLATE_ID}/clone`,
            new URLSearchParams({
                newid: vmid,
                name: nombre,
                full: 1,
                target: NODE,
                storage: STORAGE,
                format: 'qcow2'
            }),
            {
                headers: {
                    Authorization: TOKEN,
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                httpsAgent
            }
        );

        upid = cloneResp?.data?.data;
        if (!upid) throw new Error("Clone falló");

        await esperarTarea(upid);

        await axios.post(
    `${PROXMOX_URL}/api2/json/nodes/${NODE}/qemu/${vmid}/config`,
    new URLSearchParams({
        net0: 'virtio,bridge=vmbr0,firewall=1'
    }),
    {
        headers: { Authorization: TOKEN },
        httpsAgent
    }
);

        // ==================================================
        // ⚙ CPU / RAM
        // ==================================================
        await axios.post(
            `${PROXMOX_URL}/api2/json/nodes/${NODE}/qemu/${vmid}/config`,
            new URLSearchParams({
                cores: cpu,
                memory: ram
            }),
            { headers: { Authorization: TOKEN }, httpsAgent }
        );

        // ==================================================
        // ☁ CLOUD INIT
        // ==================================================
        await axios.post(
            `${PROXMOX_URL}/api2/json/nodes/${NODE}/qemu/${vmid}/config`,
            new URLSearchParams({
                ciuser: sshUser,
                cipassword: sshPass,
                ipconfig0: "ip=dhcp"
            }),
            { headers: { Authorization: TOKEN }, httpsAgent }
        );

        // ==================================================
        // 💾 DISK
        // ==================================================
        const configResp = await axios.get(
            `${PROXMOX_URL}/api2/json/nodes/${NODE}/qemu/${vmid}/config`,
            { headers: { Authorization: TOKEN }, httpsAgent }
        );

        const used = new Set();
        for (const key of Object.keys(configResp?.data?.data || {})) {
            const m = key.match(/^scsi(\d+)$/);
            if (m) used.add(parseInt(m[1]));
        }

        let free = 0;
        while (used.has(free)) free++;

        await axios.post(
            `${PROXMOX_URL}/api2/json/nodes/${NODE}/qemu/${vmid}/config`,
            new URLSearchParams({
                [`scsi${free}`]: `${STORAGE}:${disk_size}`,
                scsihw: 'virtio-scsi-pci'
            }),
            { headers: { Authorization: TOKEN }, httpsAgent }
        );

        // ==================================================
        // 🚀 START
        // ==================================================
        await axios.post(
            `${PROXMOX_URL}/api2/json/nodes/${NODE}/qemu/${vmid}/status/start`,
            new URLSearchParams({}),
            { headers: { Authorization: TOKEN }, httpsAgent }
        );

        // ==================================================
        // 🌐 IP REAL (SAFE)
        // ==================================================
        const ip = await obtenerIP(vmid);

        // ==================================================
        // 📤 RESPONSE FINAL
        // ==================================================
        const response = {
            ok: true,
            vmid,
            nombre,
            hostname,
            cpu,
            ram,
            disk_size,
            ssh: {
                user: sshUser,
                password: sshPass
            },
            ip,
            status: "running"
        };

        console.log("\n📤 RESPONSE FINAL:", response);

        res.json(response);

    } catch (error) {

        console.error("❌ ERROR:", error?.response?.data || error.message);

        res.status(500).json({
            ok: false,
            error: error?.response?.data || error.message
        });
    }
});

// ======================================================
// 🚀 SERVER
// ======================================================
app.listen(3000, () => {
    console.log("🚀 Backend en http://localhost:3000");
});