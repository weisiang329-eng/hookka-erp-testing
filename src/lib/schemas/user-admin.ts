import { z } from "zod";

// Keep the request contract aligned with the roles that exist in the RBAC
// foundation plus the two legacy compatibility roles still accepted by the
// runtime. This rejects typos/unknown privilege names before they reach the
// users or user_invites tables.
export const UserRoleSchema = z.enum([
  "SUPER_ADMIN",
  "ADMIN",
  "FINANCE",
  "PROCUREMENT",
  "PRODUCTION",
  "WAREHOUSE",
  "SALES",
  "WORKER",
  "READ_ONLY",
  "STAFF",
]);

const email = z.string().trim().email().max(254);
const password = z.string().min(1).max(1024);
const displayName = z.string().trim().max(120);
const orgLabel = z.string().trim().max(120);
const userId = z.string().trim().max(128);

export const AdminCreateUserRequestSchema = z
  .object({
    email,
    password,
    displayName: displayName.optional(),
    role: UserRoleSchema.optional().default("STAFF"),
  })
  .strict();

export const AdminUpdateUserRequestSchema = z
  .object({
    email: email.optional(),
    displayName: displayName.optional(),
    role: UserRoleSchema.optional(),
    isActive: z.boolean().optional(),
    department: orgLabel.optional(),
    position: orgLabel.optional(),
    reportsTo: userId.optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, {
    message: "At least one user field is required",
  });

export const AdminResetPasswordRequestSchema = z
  .object({ newPassword: password })
  .strict();

export const InviteUserRequestSchema = z
  .object({
    email,
    role: UserRoleSchema.optional().default("STAFF"),
    displayName: displayName.optional(),
  })
  .strict();

export const AcceptInviteRequestSchema = z
  .object({
    token: z.string().trim().min(1).max(128),
    password,
    displayName: displayName.optional(),
  })
  .strict();

export function firstUserRequestValidationError(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "Invalid request body";
  const field = issue.path.join(".");
  return field ? `${field}: ${issue.message}` : issue.message;
}

export type AdminUpdateUserRequest = z.infer<
  typeof AdminUpdateUserRequestSchema
>;
