import { z } from "zod";

const guestPath = z.string().min(1).max(4096).refine(path =>
  path.startsWith("/") && !/[\\\x00-\x1f\x7f*?\[\]]/.test(path) &&
  !path.split("/").some(part => part === "." || part === "..") && !path.includes("//"),
  "Persistence paths must be absolute guest paths without traversal or glob patterns.")
  .transform(path => path.length > 1 ? path.replace(/\/$/, "") : path);

export const persistenceSchema = z.union([
  z.enum(["workspace", "workspace-and-dependencies", "full", "none"]),
  z.strictObject({ mode: z.literal("custom"), include: z.array(guestPath).min(1).max(128),
    exclude: z.array(guestPath).max(128).optional() }),
]);
export type Persistence = z.infer<typeof persistenceSchema>;
export function environmentPersistence(environment: { persistence?: Persistence }): Persistence {
  return environment.persistence ?? "full";
}
export function samePersistence(a: Persistence, b: Persistence) {
  return JSON.stringify(a) === JSON.stringify(b);
}
