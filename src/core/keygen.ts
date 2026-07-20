// 纯 Node 生成 ed25519 SSH 密钥对 —— 不依赖系统的 ssh-keygen（纯 Windows 也能开箱即用）。
// 产出 OpenSSH 格式私钥（ssh2/node-ssh 能直接加载）+ authorized_keys 格式公钥行。
import { generateKeyPairSync, randomBytes } from "node:crypto";

/** SSH 线格式字符串：4 字节大端长度 + 内容。 */
function sshStr(buf: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length, 0);
  return Buffer.concat([len, buf]);
}

export interface Ed25519Key {
  privatePem: string;   // OpenSSH 私钥（-----BEGIN OPENSSH PRIVATE KEY-----）
  publicLine: string;   // ssh-ed25519 AAAA... comment
}

export function generateEd25519(comment = "vibe-launch"): Ed25519Key {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  // 从 DER 里取原始 32 字节：SPKI 末尾 32 字节=公钥；PKCS8 末尾 32 字节=私钥种子
  const rawPub = (publicKey.export({ type: "spki", format: "der" }) as Buffer).subarray(-32);
  const seed = (privateKey.export({ type: "pkcs8", format: "der" }) as Buffer).subarray(-32);

  const TYPE = Buffer.from("ssh-ed25519");
  const pubWire = Buffer.concat([sshStr(TYPE), sshStr(rawPub)]);

  // 公钥行（authorized_keys 格式）
  const publicLine = `ssh-ed25519 ${pubWire.toString("base64")} ${comment}`;

  // 私钥（OpenSSH 明文格式：cipher=none kdf=none 单把 key）
  const check = randomBytes(4);
  let privBlock = Buffer.concat([
    check, check,
    sshStr(TYPE), sshStr(rawPub),
    sshStr(Buffer.concat([seed, rawPub])), // ed25519 私钥=种子(32)+公钥(32)
    sshStr(Buffer.from(comment)),
  ]);
  for (let pad = 1; privBlock.length % 8 !== 0; pad++) privBlock = Buffer.concat([privBlock, Buffer.from([pad & 0xff])]);

  const body = Buffer.concat([
    Buffer.from("openssh-key-v1\0", "binary"),
    sshStr(Buffer.from("none")),      // ciphername
    sshStr(Buffer.from("none")),      // kdfname
    sshStr(Buffer.alloc(0)),          // kdfoptions
    Buffer.from([0, 0, 0, 1]),        // 1 把 key
    sshStr(pubWire),                  // 公钥
    sshStr(privBlock),                // 私钥段
  ]);
  const b64 = (body.toString("base64").match(/.{1,70}/g) || []).join("\n");
  const privatePem = `-----BEGIN OPENSSH PRIVATE KEY-----\n${b64}\n-----END OPENSSH PRIVATE KEY-----\n`;

  return { privatePem, publicLine };
}
