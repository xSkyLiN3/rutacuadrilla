import { z } from "zod";

export const accountEmailSchema = z.email().max(254);
export const loginPasswordSchema = z.string().min(1).max(256);
export const newAccountPasswordSchema = z.string().min(12).max(256);
