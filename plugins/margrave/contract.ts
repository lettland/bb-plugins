import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const catalogErrors = {
  missing:
    "Margrave is unavailable on the BB server. Add the margrave executable to the server PATH.",
  failed: "Could not read the Margrave skill catalog.",
  invalid: "Margrave returned an invalid skill catalog.",
} as const;

export const catalogSchema = z.object({
  skills: z.array(
    z.object({ id: z.string(), name: z.string(), description: z.string() }),
  ),
});

export const rpcContract = defineRpcContract({
  listSkills: {
    input: z.null(),
    output: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), skills: catalogSchema.shape.skills }),
      z.object({
        ok: z.literal(false),
        error: z.enum(["missing", "failed", "invalid"]),
      }),
    ]),
  },
});
