import { DecryptCommand, DescribeKeyCommand, EncryptCommand, GenerateMacCommand, KMSClient } from "@aws-sdk/client-kms";
import { DeleteObjectCommand, DeleteObjectsCommand, GetObjectCommand, GetObjectTaggingCommand, HeadBucketCommand, HeadObjectCommand, PutObjectCommand, PutObjectTaggingCommand, S3Client } from "@aws-sdk/client-s3";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { mockClient } from "aws-sdk-client-mock";
import { createHmac, randomBytes } from "node:crypto";
import { describe, expect, it, beforeEach } from "vitest";
import { LocalTestKms } from "../../../modules/sizing/test/local-test-kms";
import { ProviderNotConfiguredError } from "../../unconfigured";
import { parseAwsEnv, AwsKmsPort, AwsSecrets, AwsSigningSecrets, AwsTokenKeySource, KmsFieldCipher, ProviderUnavailableError, S3ObjectStore, createAwsAdapters, MAX_UPLOAD_BYTES } from "./index";

const noSleep = async (): Promise<void> => undefined;
const UUID = "0194f5c0-7a3b-7c1e-9d2a-1b2c3d4e5f60";
const s3Mock = mockClient(S3Client);
const kmsMock = mockClient(KMSClient);
const smMock = mockClient(SecretsManagerClient);
beforeEach(() => {
  s3Mock.reset();
  kmsMock.reset();
  smMock.reset();
});

function errNamed(name: string): Error {
  const e = new Error(name);
  e.name = name;
  return e;
}
function store(kms: string | null = "alias/outlet-s3") {
  const client = new S3Client({ region: "eu-south-1", credentials: { accessKeyId: "AK", secretAccessKey: "SK" } });
  return new S3ObjectStore(client, { bucket: "b-outlet", kmsKeyId: kms ?? undefined }, client, undefined, undefined, () => new Date("2026-10-11T00:00:00Z"), noSleep);
}

describe("config", () => {
  it("is empty without vars and flags missing pairs", () => {
    expect(parseAwsEnv({}).config.s3).toBeNull();
    expect(parseAwsEnv({ KMS_KEY_ID: "k" }).issues.join()).toContain("KMS_HMAC_KEY_ID");
    expect(parseAwsEnv({ S3_BUCKET: "bucket1", AWS_REGION: "r" }).issues.join()).toContain("S3_KMS_KEY_ID");
    const ok = parseAwsEnv({ S3_BUCKET: "bucket1", S3_ENDPOINT: "http://minio:9000", S3_ALLOW_SSE_S3: "true" });
    expect(ok.config.s3?.forcePathStyle).toBe(true);
    expect(createAwsAdapters(parseAwsEnv({}).config).probes.size).toBe(0);
  });
});

describe("S3ObjectStore", () => {
  it("presigned PUT signs content-type, exact length, SSE-KMS and tags; key has no PII", async () => {
    const u = await store().presignUpload({ purpose: "return-evidence", ownerId: UUID, contentType: "image/jpeg", sizeBytes: 12345 });
    expect(u.key).toMatch(/^return-evidence\/2026\/10\/[0-9a-f-]{36}$/);
    expect(u.key).not.toContain(UUID);
    const q = new URL(u.url).searchParams;
    const signed = (q.get("X-Amz-SignedHeaders") ?? "").split(";");
    for (const h of ["content-type", "content-length", "x-amz-server-side-encryption", "x-amz-server-side-encryption-aws-kms-key-id", "x-amz-tagging", `x-amz-meta-owner`]) expect(signed).toContain(h);
    expect(q.get("X-Amz-Expires")).toBe("600");
    expect(u.headers["x-amz-server-side-encryption"]).toBe("aws:kms");
    expect(u.headers["x-amz-server-side-encryption-aws-kms-key-id"]).toBe("alias/outlet-s3");
  });
  it("rejects disallowed types and oversize", async () => {
    const s = store();
    await expect(s.presignUpload({ purpose: "catalog", ownerId: UUID, contentType: "text/html", sizeBytes: 10 })).rejects.toThrow(RangeError);
    await expect(s.presignUpload({ purpose: "catalog", ownerId: UUID, contentType: "image/png", sizeBytes: MAX_UPLOAD_BYTES + 1 })).rejects.toThrow(RangeError);
  });
  it("presigned GET is capped at 15 min and refused unless scan=clean", async () => {
    const s = store();
    s3Mock.on(GetObjectTaggingCommand).resolvesOnce({ TagSet: [{ Key: "scan", Value: "pending_scan" }] }).resolves({ TagSet: [{ Key: "scan", Value: "clean" }] });
    expect(await s.presignDownload("kyc/2026/10/" + UUID, 900)).toBeNull();
    const g = await s.presignDownload("kyc/2026/10/" + UUID, 86_400);
    expect(new URL(g?.url ?? "").searchParams.get("X-Amz-Expires")).toBe("900");
  });
  it("put sets SSE-KMS and pending_scan tag; SSE-S3 when no key", async () => {
    s3Mock.on(PutObjectCommand).resolves({});
    await store().put("k", new Uint8Array([1]), "image/png", { ownerId: UUID });
    const i = s3Mock.commandCalls(PutObjectCommand)[0]?.args[0].input;
    expect(i).toMatchObject({ ServerSideEncryption: "aws:kms", SSEKMSKeyId: "alias/outlet-s3", Tagging: "scan=pending_scan" });
    await store(null).put("k", new Uint8Array([1]), "image/png");
    expect(s3Mock.commandCalls(PutObjectCommand)[1]?.args[0].input.ServerSideEncryption).toBe("AES256");
  });
  it("get/head/delete/deleteMany and missing mapping", async () => {
    const s = store();
    s3Mock.on(GetObjectCommand).rejectsOnce(errNamed("NoSuchKey"));
    expect(await s.get("x")).toBeNull();
    s3Mock.on(HeadObjectCommand).resolves({ ContentLength: 5, ContentType: "image/png", Metadata: { owner: UUID } });
    expect(await s.head("x")).toEqual({ size: 5, contentType: "image/png", ownerId: UUID });
    s3Mock.on(DeleteObjectCommand).resolves({});
    await s.delete("x");
    s3Mock.on(DeleteObjectsCommand).resolves({});
    await s.deleteMany(Array.from({ length: 1500 }, (_, i) => `k${i}`));
    expect(s3Mock.commandCalls(DeleteObjectsCommand)).toHaveLength(2);
    s3Mock.on(DeleteObjectsCommand).resolves({ Errors: [{ Key: "a" }] });
    await expect(s.deleteMany(["a"])).rejects.toBeInstanceOf(ProviderUnavailableError);
  });
  it("ownership uses the key scheme and owner metadata; evidence/photos facades", async () => {
    const s = store();
    const key = `return-evidence/2026/10/${UUID}`;
    s3Mock.on(HeadObjectCommand).resolves({ Metadata: { owner: UUID } });
    expect(await s.evidence().ownedBy(UUID, [key])).toBe(true);
    expect(await s.evidence().ownedBy("someone-else", [key])).toBe(false);
    expect(await s.evidence().ownedBy(UUID, ["../etc/passwd"])).toBe(false);
    expect(await s.photos().areOwnedImages(UUID, [key])).toBe(false);
  });
  it("without a scanner objects stay pending_scan; with one they are tagged", async () => {
    expect(await store().processUpload("x")).toBe("pending_scan");
    const client = new S3Client({ region: "r", credentials: { accessKeyId: "a", secretAccessKey: "b" } });
    const calls: string[] = [];
    const s = new S3ObjectStore(client, { bucket: "b-outlet", kmsKeyId: "k" }, client, { scan: async () => "clean" }, { strip: async (b) => { calls.push("strip"); return b; } });
    s3Mock.on(GetObjectCommand).resolves({ Body: { transformToByteArray: async () => new Uint8Array([1]) } as never });
    s3Mock.on(HeadObjectCommand).resolves({ ContentType: "image/jpeg", Metadata: { owner: UUID } });
    s3Mock.on(PutObjectCommand).resolves({});
    s3Mock.on(PutObjectTaggingCommand).resolves({});
    expect(await s.processUpload("x")).toBe("clean");
    expect(calls).toEqual(["strip"]);
    expect(s3Mock.commandCalls(PutObjectTaggingCommand)[0]?.args[0].input.Tagging?.TagSet?.[0]).toEqual({ Key: "scan", Value: "clean" });
  });
  it("privacy facade only accepts export keys and refuses unscanned downloads", async () => {
    const p = store().privacy();
    await expect(p.put("evil/key", new Uint8Array(), "application/zip")).rejects.toThrow(RangeError);
    s3Mock.on(PutObjectCommand).resolves({});
    await p.put(`exports/${UUID}/${UUID}.zip`, new Uint8Array([1]), "application/zip");
    s3Mock.on(GetObjectTaggingCommand).resolves({ TagSet: [] });
    await expect(p.signGetUrl("x", 60, 0)).rejects.toThrow(RangeError);
  });
  it("error mapping and throttle retry only when idempotent", async () => {
    const s = store();
    s3Mock.on(HeadObjectCommand).rejectsOnce(errNamed("SlowDown")).resolves({ ContentLength: 1 });
    expect((await s.head("x"))?.size).toBe(1);
    s3Mock.on(HeadObjectCommand).rejects(errNamed("AccessDenied"));
    await expect(s.head("x")).rejects.toBeInstanceOf(ProviderNotConfiguredError);
    s3Mock.on(HeadObjectCommand).rejects(errNamed("InternalError"));
    await expect(s.head("x")).rejects.toMatchObject({ status: 502 });
    s3Mock.reset();
    s3Mock.on(HeadObjectCommand).rejects(errNamed("SlowDown"));
    await expect(s.head("x")).rejects.toMatchObject({ status: 502 });
    expect(s3Mock.commandCalls(HeadObjectCommand)).toHaveLength(3);
  });
  it("readiness probe", async () => {
    s3Mock.on(HeadBucketCommand).resolves({});
    expect(await store().ready()).toBe(true);
    s3Mock.on(HeadBucketCommand).rejects(errNamed("NotFound"));
    expect(await store().ready()).toBe(false);
  });
});

describe("KMS", () => {
  const settings = { keyId: "alias/outlet", keyVersion: 1, hmacKeyId: "alias/outlet-mac", probeTimeoutMs: 500 };
  it("wrap/unwrap bind the encryption context, hmac uses GenerateMac", async () => {
    kmsMock.on(EncryptCommand).resolves({ CiphertextBlob: new Uint8Array([9, 9]), KeyId: "arn:aws:kms:r:1:key/abc" });
    const k = new AwsKmsPort(new KMSClient({ region: "r" }), settings, noSleep);
    const w = await k.wrapKey(new Uint8Array(32), "users:dob:1");
    expect(w).toMatchObject({ keyId: "arn:aws:kms:r:1:key/abc", keyVersion: 1 });
    expect(kmsMock.commandCalls(EncryptCommand)[0]?.args[0].input.EncryptionContext).toEqual({ ctx: "users:dob:1" });
    kmsMock.on(DecryptCommand).resolves({ Plaintext: new Uint8Array([7]) });
    await k.unwrapKey({ keyId: w.keyId, keyVersion: 1, wrapped: w.wrapped, context: "users:dob:1" });
    expect(kmsMock.commandCalls(DecryptCommand)[0]?.args[0].input.KeyId).toBe("arn:aws:kms:r:1:key/abc");
    kmsMock.on(GenerateMacCommand).resolves({ Mac: new Uint8Array(32) });
    expect((await k.hmac("phone", new Uint8Array([1]))).length).toBe(32);
    expect(kmsMock.commandCalls(GenerateMacCommand)[0]?.args[0].input.MacAlgorithm).toBe("HMAC_SHA_256");
  });
  it("maps errors and probes DescribeKey", async () => {
    const k = new AwsKmsPort(new KMSClient({ region: "r" }), settings, noSleep);
    kmsMock.on(EncryptCommand).rejects(errNamed("AccessDeniedException"));
    await expect(k.wrapKey(new Uint8Array(32), "c")).rejects.toBeInstanceOf(ProviderNotConfiguredError);
    kmsMock.on(DecryptCommand).rejects(errNamed("KMSInternalException"));
    await expect(k.unwrapKey({ keyId: "k", keyVersion: 1, wrapped: new Uint8Array(), context: "c" })).rejects.toMatchObject({ status: 502 });
    kmsMock.on(DescribeKeyCommand).resolves({});
    expect(await k.ready()).toBe(true);
    kmsMock.on(DescribeKeyCommand).rejects(errNamed("X"));
    expect(await k.ready()).toBe(false);
  });
  it("field cipher round trips through rotation and blind index is 32 bytes", async () => {
    const local = new LocalTestKms();
    const c = new KmsFieldCipher(local);
    const old = await c.encrypt("+201001234567", "users.phone");
    local.rotate();
    const fresh = await c.encrypt("+201001234567", "users.phone");
    expect(await c.decrypt(old, "users.phone")).toBe("+201001234567");
    expect(await c.decrypt(fresh, "users.phone")).toBe("+201001234567");
    await expect(c.decrypt(fresh, "users.email")).rejects.toThrow();
    const bi = await c.blindIndex("phone", "x");
    expect(bi.length).toBe(32);
    expect(Buffer.from(bi).equals(Buffer.from(await c.blindIndex("phone", "x")))).toBe(true);
    expect(Buffer.from(bi).equals(Buffer.from(await c.blindIndex("email", "x")))).toBe(false);
  });
});

describe("Secrets Manager", () => {
  it("caches by stage, never leaks values in errors, previous stage may be absent", async () => {
    let t = 0;
    const sm = new AwsSecrets(new SecretsManagerClient({ region: "r" }), 60, () => t, 500, noSleep);
    smMock.on(GetSecretValueCommand).resolves({ SecretString: "v1", VersionId: "ver1" });
    expect(await sm.get("id")).toBe("v1");
    await sm.get("id");
    expect(smMock.commandCalls(GetSecretValueCommand)).toHaveLength(1);
    expect(sm.currentVersion("id")).toBe("ver1");
    t = 61_000;
    await sm.get("id");
    expect(smMock.commandCalls(GetSecretValueCommand)).toHaveLength(2);
    smMock.on(GetSecretValueCommand, { VersionStage: "AWSPREVIOUS" }).rejects(errNamed("ResourceNotFoundException"));
    expect(await sm.get("id", "AWSPREVIOUS")).toBeNull();
    smMock.on(GetSecretValueCommand).rejects(errNamed("InternalServiceError"));
    sm.invalidate();
    await expect(sm.get("id")).rejects.toMatchObject({ status: 502 });
    smMock.on(GetSecretValueCommand).resolves({});
    await expect(sm.get("id")).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(await sm.ready("id")).toBe(true);
  });
  it("token key source parses JSON and fails closed on garbage", async () => {
    const sm = new AwsSecrets(new SecretsManagerClient({ region: "r" }), 0, Date.now, 500, noSleep);
    const src = new AwsTokenKeySource(sm, "id");
    smMock.on(GetSecretValueCommand).resolves({ SecretString: JSON.stringify({ activeKid: "k1", keys: [{ kid: "k1" }] }) });
    expect((await src.load()).activeKid).toBe("k1");
    smMock.on(GetSecretValueCommand).resolves({ SecretString: "not json" });
    await expect(src.load()).rejects.toBeInstanceOf(ProviderUnavailableError);
    smMock.on(GetSecretValueCommand).resolves({ SecretString: "{}" });
    await expect(src.load()).rejects.toBeInstanceOf(ProviderUnavailableError);
  });
  it("signing secrets: current + previous kid verification during rotation", async () => {
    const k1 = randomBytes(32).toString("base64");
    const k2 = randomBytes(32).toString("base64");
    smMock.on(GetSecretValueCommand, { VersionStage: "AWSCURRENT" }).resolves({ SecretString: JSON.stringify({ activeKid: "b", keys: [{ kid: "b", key: k2 }] }) });
    smMock.on(GetSecretValueCommand, { VersionStage: "AWSPREVIOUS" }).resolves({ SecretString: JSON.stringify({ activeKid: "a", keys: [{ kid: "a", key: k1 }] }) });
    const s = new AwsSigningSecrets(new AwsSecrets(new SecretsManagerClient({ region: "r" }), 0, Date.now, 500, noSleep), "id");
    expect((await s.current()).kid).toBe("b");
    expect(Buffer.from((await s.byKid("a")) ?? []).toString("base64")).toBe(k1);
    expect(await s.byKid("zzz")).toBeNull();
    void createHmac;
  });
});
