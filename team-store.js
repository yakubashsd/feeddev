"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function deriveKey(secret) { return crypto.createHash("sha256").update(String(secret)).digest(); }
function encode(value, secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", deriveKey(secret), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}
function decode(value, secret) {
  const bytes = Buffer.from(String(value).trim(), "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", deriveKey(secret), bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8"));
}
function passwordHash(password, salt = crypto.randomBytes(16).toString("hex")) {
  return `${salt}:${crypto.scryptSync(String(password), salt, 64).toString("hex")}`;
}
function verifyPassword(password, stored) {
  const [salt, expected] = String(stored || "").split(":");
  if (!salt || !expected) return false;
  const actual = crypto.scryptSync(String(password), salt, 64);
  const wanted = Buffer.from(expected, "hex");
  return actual.length === wanted.length && crypto.timingSafeEqual(actual, wanted);
}
function publicUser(user) {
  return { id: user.id, username: user.username, name: user.name, role: user.role, mustChangePassword: Boolean(user.mustChangePassword), active: user.active !== false, createdAt: user.createdAt };
}

function createTeamStore({ dataDir, secret, adminUsername, adminPassword }) {
  const file = path.join(dataDir, "team-users.enc");
  const read = () => {
    if (!fs.existsSync(file)) return { version: 1, users: [] };
    try { return decode(fs.readFileSync(file, "utf8"), secret); } catch { return { version: 1, users: [] }; }
  };
  const write = state => { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(file, `${encode(state, secret)}\n`, { mode: 0o600 }); };
  const ensureAdmin = () => {
    const state = read();
    if (!state.users.length && adminUsername && adminPassword) {
      const now = new Date().toISOString();
      state.users.push({ id: crypto.randomUUID(), username: String(adminUsername).trim(), name: "Администратор", role: "owner", passwordHash: passwordHash(adminPassword), mustChangePassword: false, active: true, createdAt: now, updatedAt: now });
      write(state);
    }
    return state;
  };
  const authenticate = (username, password) => {
    const state = ensureAdmin();
    const user = state.users.find(item => item.username.toLowerCase() === String(username || "").trim().toLowerCase() && item.active !== false);
    return user && verifyPassword(password, user.passwordHash) ? publicUser(user) : null;
  };
  const get = id => { const user = ensureAdmin().users.find(item => item.id === id); return user ? publicUser(user) : null; };
  const list = () => ensureAdmin().users.map(publicUser);
  const create = ({ username, name, password, role = "editor" }) => {
    username = String(username || "").trim(); name = String(name || "").trim(); password = String(password || "");
    if (!/^[a-zA-Z0-9._-]{3,80}$/.test(username)) throw new Error("Логин: от 3 до 80 латинских символов, цифр, точки, дефиса или подчёркивания.");
    if (password.length < 8) throw new Error("Временный пароль должен содержать минимум 8 символов.");
    if (!name) throw new Error("Укажите имя пользователя.");
    if (!["editor", "viewer"].includes(role)) throw new Error("Недопустимая роль.");
    const state = ensureAdmin();
    if (state.users.some(user => user.username.toLowerCase() === username.toLowerCase())) throw new Error("Такой логин уже существует.");
    const now = new Date().toISOString();
    const user = { id: crypto.randomUUID(), username, name: name.slice(0, 120), role, passwordHash: passwordHash(password), mustChangePassword: true, active: true, createdAt: now, updatedAt: now };
    state.users.push(user); write(state); return publicUser(user);
  };
  const changePassword = (id, nextPassword) => {
    if (String(nextPassword || "").length < 8) throw new Error("Пароль должен содержать минимум 8 символов.");
    const state = ensureAdmin(); const user = state.users.find(item => item.id === id);
    if (!user) throw new Error("Пользователь не найден.");
    user.passwordHash = passwordHash(nextPassword); user.mustChangePassword = false; user.updatedAt = new Date().toISOString(); write(state); return publicUser(user);
  };
  return { authenticate, get, list, create, changePassword };
}

module.exports = { createTeamStore };
