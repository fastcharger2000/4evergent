import { test } from "node:test";
import assert from "node:assert/strict";
import { Account, Keypair, Networks } from "@stellar/stellar-sdk";
import { StellarTransactionBuilder } from "../src/transaction-builder.js";
import type { AccountSettingsIntent, SetOptionsOptions } from "@4evergent/shared";

const NETWORK = Networks.TESTNET;
const builder = new StellarTransactionBuilder();
const addr = () => Keypair.random().publicKey();

function fakeAccount(sequence: string) {
  return new Account(addr(), sequence);
}

function getSetOptionsOp(tx: any) {
  assert.equal(tx.operations.length, 1);
  const op = tx.operations[0];
  assert.equal(op.type, "setOptions");
  return op;
}

function getSetOptionsBuilderOp(tx: any) {
  assert.equal(tx.operations.length, 1);
  const op = tx.operations[0];
  assert.equal(op.type, "setOptions");
  return op;
}

// ── home_domain ──────────────────────────────────────────────
test("ACCOUNT SETTINGS: builds home_domain op", async () => {
  const acct = fakeAccount("100");
  const intent: AccountSettingsIntent = { type: "account_settings", setting: "home_domain", value: "example.com", reason: "set domain" };
  const tx = await builder.buildAccountSettings(acct, intent, NETWORK);
  const op = getSetOptionsOp(tx);
  assert.equal(op.homeDomain, "example.com");
  assert.equal(op.type, "setOptions");
});

// ── inflation_destination ────────────────────────────────────
test("ACCOUNT SETTINGS: builds inflation_destination op", async () => {
  const acct = fakeAccount("100");
  const destination = addr();
  const intent: AccountSettingsIntent = { type: "account_settings", setting: "inflation_destination", value: destination, reason: "set inflation" };
  const tx = await builder.buildAccountSettings(acct, intent, NETWORK);
  const op = getSetOptionsOp(tx);
  assert.equal(op.inflationDest, destination);
  assert.equal(op.type, "setOptions");
});

// ── signer ───────────────────────────────────────────────────
test("ACCOUNT SETTINGS: builds signer op", async () => {
  const acct = fakeAccount("100");
  const key = addr();
  const intent: AccountSettingsIntent = { type: "account_settings", setting: "signer", value: { key, weight: 1 }, reason: "add signer" };
  const tx = await builder.buildAccountSettings(acct, intent, NETWORK);
  const op = getSetOptionsOp(tx);
  assert.equal(op.signer.ed25519PublicKey, key);
  assert.equal(op.signer.weight, 1);
});

// ── thresholds ───────────────────────────────────────────────
test("ACCOUNT SETTINGS: builds thresholds op", async () => {
  const acct = fakeAccount("100");
  const intent: AccountSettingsIntent = { type: "account_settings", setting: "thresholds", value: { low: 1, medium: 2, high: 3, master: 4 }, reason: "set thresholds" };
  const tx = await builder.buildAccountSettings(acct, intent, NETWORK);
  const op = getSetOptionsOp(tx);
  assert.equal(op.lowThreshold, 1);
  assert.equal(op.medThreshold, 2);
  assert.equal(op.highThreshold, 3);
  assert.equal(op.masterWeight, 4);
});

// ── set_flags ────────────────────────────────────────────────
test("ACCOUNT SETTINGS: builds set_flags op", async () => {
  const acct = fakeAccount("100");
  const intent: AccountSettingsIntent = { type: "account_settings", setting: "set_flags", value: [1, 2], reason: "set flags" };
  const tx = await builder.buildAccountSettings(acct, intent, NETWORK);
  const op = getSetOptionsOp(tx);
  assert.equal(op.setFlags, 3); // 1 | 2
});

// ── clear_flags ──────────────────────────────────────────────
test("ACCOUNT SETTINGS: builds clear_flags op", async () => {
  const acct = fakeAccount("100");
  const intent: AccountSettingsIntent = { type: "account_settings", setting: "clear_flags", value: [1], reason: "clear flags" };
  const tx = await builder.buildAccountSettings(acct, intent, NETWORK);
  const op = getSetOptionsOp(tx);
  assert.equal(op.clearFlags, 1);
});

// ── validation: unknown setting ──────────────────────────────
test("ACCOUNT SETTINGS: throws on unknown setting", async () => {
  const acct = fakeAccount("100");
  const intent: AccountSettingsIntent = { type: "account_settings", setting: "unknown_setting", value: "x", reason: "test" };
  await assert.rejects(() => builder.buildAccountSettings(acct, intent, NETWORK), /unknown account_settings type/);
});

// ── validation: missing setting ──────────────────────────────
test("ACCOUNT SETTINGS: throws on missing setting", async () => {
  const acct = fakeAccount("100");
  const intent: AccountSettingsIntent = { type: "account_settings", setting: "", value: "x", reason: "test" };
  await assert.rejects(() => builder.buildAccountSettings(acct, intent, NETWORK), /setting field required/);
});

// ── validation: wrong intent type ────────────────────────────
test("ACCOUNT SETTINGS: throws on wrong intent type", async () => {
  const acct = fakeAccount("100");
  const intent = { type: "payment", amount: "1", destination: addr(), reason: "test" } as any;
  await assert.rejects(() => builder.buildAccountSettings(acct, intent, NETWORK), /expected account_settings intent/);
});

// ── validation: bad home_domain value ────────────────────────
test("ACCOUNT SETTINGS: throws on empty home_domain", async () => {
  const acct = fakeAccount("100");
  const intent: AccountSettingsIntent = { type: "account_settings", setting: "home_domain", value: "", reason: "test" };
  await assert.rejects(() => builder.buildAccountSettings(acct, intent, NETWORK), /home_domain value must be a non-empty string/);
});

// ── validation: bad inflation_destination ─────────────────────
test("ACCOUNT SETTINGS: throws on invalid inflation_destination", async () => {
  const acct = fakeAccount("100");
  const intent: AccountSettingsIntent = { type: "account_settings", setting: "inflation_destination", value: "not-an-address", reason: "test" };
  await assert.rejects(() => builder.buildAccountSettings(acct, intent, NETWORK), /inflation_destination must be a valid Stellar address/);
});

// ── validation: bad signer weight ────────────────────────────
test("ACCOUNT SETTINGS: throws on signer weight > 255", async () => {
  const acct = fakeAccount("100");
  const intent: AccountSettingsIntent = { type: "account_settings", setting: "signer", value: { key: addr(), weight: 300 }, reason: "test" };
  await assert.rejects(() => builder.buildAccountSettings(acct, intent, NETWORK), /signer.weight must be a number between 0 and 255/);
});

// ── validation: bad thresholds ───────────────────────────────
test("ACCOUNT SETTINGS: throws on missing thresholds field", async () => {
  const acct = fakeAccount("100");
  const intent: AccountSettingsIntent = { type: "account_settings", setting: "thresholds", value: { low: 1, medium: 2 }, reason: "test" };
  await assert.rejects(() => builder.buildAccountSettings(acct, intent, NETWORK), /thresholds\..* must be a number/);
});

// ── buildSetOptions: signer add ──────────────────────────────
test("SET OPTIONS: builds signer add op", async () => {
  const acct = fakeAccount("100");
  const key = addr();
  const options: SetOptionsOptions = { signer: { key, weight: 1 } };
  const tx = await builder.buildSetOptions(acct, options, NETWORK);
  const op = getSetOptionsBuilderOp(tx);
  assert.equal(op.signer.ed25519PublicKey, key);
  assert.equal(op.signer.weight, 1);
});

// ── buildSetOptions: signer update ───────────────────────────
test("SET OPTIONS: builds signer update op", async () => {
  const acct = fakeAccount("100");
  const key = addr();
  const options: SetOptionsOptions = { signer: { key, weight: 5 } };
  const tx = await builder.buildSetOptions(acct, options, NETWORK);
  const op = getSetOptionsBuilderOp(tx);
  assert.equal(op.signer.ed25519PublicKey, key);
  assert.equal(op.signer.weight, 5);
});

// ── buildSetOptions: signer remove ───────────────────────────
test("SET OPTIONS: builds signer remove op", async () => {
  const acct = fakeAccount("100");
  const key = addr();
  const options: SetOptionsOptions = { signer: { key, weight: 0 } };
  const tx = await builder.buildSetOptions(acct, options, NETWORK);
  const op = getSetOptionsBuilderOp(tx);
  assert.equal(op.signer.ed25519PublicKey, key);
  assert.equal(op.signer.weight, 0);
});

// ── buildSetOptions: flag set ────────────────────────────────
test("SET OPTIONS: builds setFlags op", async () => {
  const acct = fakeAccount("100");
  const options: SetOptionsOptions = { setFlags: 3 };
  const tx = await builder.buildSetOptions(acct, options, NETWORK);
  const op = getSetOptionsBuilderOp(tx);
  assert.equal(op.setFlags, 3);
});

// ── buildSetOptions: flag clear ──────────────────────────────
test("SET OPTIONS: builds clearFlags op", async () => {
  const acct = fakeAccount("100");
  const options: SetOptionsOptions = { clearFlags: 1 };
  const tx = await builder.buildSetOptions(acct, options, NETWORK);
  const op = getSetOptionsBuilderOp(tx);
  assert.equal(op.clearFlags, 1);
});

// ── buildSetOptions: thresholds ──────────────────────────────
test("SET OPTIONS: builds threshold change op", async () => {
  const acct = fakeAccount("100");
  const options: SetOptionsOptions = { masterWeight: 4, lowThreshold: 1, medThreshold: 2, highThreshold: 3 };
  const tx = await builder.buildSetOptions(acct, options, NETWORK);
  const op = getSetOptionsBuilderOp(tx);
  assert.equal(op.masterWeight, 4);
  assert.equal(op.lowThreshold, 1);
  assert.equal(op.medThreshold, 2);
  assert.equal(op.highThreshold, 3);
});

// ── buildSetOptions: home domain ─────────────────────────────
test("SET OPTIONS: builds homeDomain op", async () => {
  const acct = fakeAccount("100");
  const options: SetOptionsOptions = { homeDomain: "example.com" };
  const tx = await builder.buildSetOptions(acct, options, NETWORK);
  const op = getSetOptionsBuilderOp(tx);
  assert.equal(op.homeDomain, "example.com");
});

// ── buildSetOptions: inflation destination ───────────────────
test("SET OPTIONS: builds inflationDest op", async () => {
  const acct = fakeAccount("100");
  const destination = addr();
  const options: SetOptionsOptions = { inflationDest: destination };
  const tx = await builder.buildSetOptions(acct, options, NETWORK);
  const op = getSetOptionsBuilderOp(tx);
  assert.equal(op.inflationDest, destination);
});

// ── buildSetOptions: omitted fields unchanged ────────────────
test("SET OPTIONS: omitting fields leaves them undefined", async () => {
  const acct = fakeAccount("100");
  const options: SetOptionsOptions = { homeDomain: "example.com" };
  const tx = await builder.buildSetOptions(acct, options, NETWORK);
  const op = getSetOptionsBuilderOp(tx);
  assert.equal(op.homeDomain, "example.com");
  assert.equal(op.signer, undefined);
  assert.equal(op.setFlags, undefined);
  assert.equal(op.clearFlags, undefined);
  assert.equal(op.masterWeight, undefined);
  assert.equal(op.lowThreshold, undefined);
  assert.equal(op.medThreshold, undefined);
  assert.equal(op.highThreshold, undefined);
});

// ── buildSetOptions: empty options throws ────────────────────
test("SET OPTIONS: throws on empty options object", async () => {
  const acct = fakeAccount("100");
  const options: SetOptionsOptions = {};
  await assert.rejects(() => builder.buildSetOptions(acct, options, NETWORK), /at least one setOptions field required/);
});

// ── buildSetOptions: invalid signer weight ───────────────────
test("SET OPTIONS: throws on signer weight > 255", async () => {
  const acct = fakeAccount("100");
  const options: SetOptionsOptions = { signer: { key: addr(), weight: 300 } };
  await assert.rejects(() => builder.buildSetOptions(acct, options, NETWORK), /signer.weight must be a number between 0 and 255/);
});

// ── buildSetOptions: invalid home domain ─────────────────────
test("SET OPTIONS: throws on empty homeDomain", async () => {
  const acct = fakeAccount("100");
  const options: SetOptionsOptions = { homeDomain: "" };
  await assert.rejects(() => builder.buildSetOptions(acct, options, NETWORK), /homeDomain value must be a non-empty string/);
});

// ── buildSetOptions: invalid inflation destination ───────────
test("SET OPTIONS: throws on invalid inflationDest", async () => {
  const acct = fakeAccount("100");
  const options: SetOptionsOptions = { inflationDest: "not-an-address" };
  await assert.rejects(() => builder.buildSetOptions(acct, options, NETWORK), /inflationDest must be a valid Stellar address/);
});
