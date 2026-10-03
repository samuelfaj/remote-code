import { CryptoDigestAlgorithm, CryptoEncoding, digestStringAsync } from "expo-crypto";
import { fileContentFromValue } from "@remotecode/client";
import { validText } from "./file-rules";
export * from "./file-rules";

export type OpenFile = { workspaceId: string; path: string; content: string; version: string };

export async function textSha256(content: string) {
  if (!validText(content)) throw new Error("Unsupported text or file too large");
  return digestStringAsync(CryptoDigestAlgorithm.SHA256, content, { encoding: CryptoEncoding.HEX });
}

export async function openFileFromValue(value: unknown, workspaceId: string, path: string): Promise<OpenFile | null> {
  const data = fileContentFromValue(value, path);
  if (!data || await textSha256(data.content) !== data.version) return null;
  return { workspaceId, ...data };
}
