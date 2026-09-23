import {
  requestPasswordResetSchema,
  resetPasswordSchema,
  signUpSchema,
  verifyEmailSchema,
  type RequestPasswordResetInput,
  type ResetPasswordInput,
  type SignUpInput,
  type VerifyEmailInput,
} from '@videochat/shared';
import { z } from 'zod';
import { apiPost } from '../../lib/api';

/** Every non-session auth endpoint replies with `{ message }` -- there's nothing else in the
 *  contract worth typing more precisely than that. */
export const messageResponseSchema = z.object({ message: z.string() });

export const signUp = (input: SignUpInput) => {
  signUpSchema.parse(input);
  return apiPost('/auth/signup', messageResponseSchema, input);
};

export const resendVerification = (email: string) =>
  apiPost('/auth/resend-verification', messageResponseSchema, { email });

export const verifyEmail = (input: VerifyEmailInput) => {
  verifyEmailSchema.parse(input);
  return apiPost('/auth/verify-email', messageResponseSchema, input);
};

export const requestPasswordReset = (input: RequestPasswordResetInput) => {
  requestPasswordResetSchema.parse(input);
  return apiPost('/auth/request-password-reset', messageResponseSchema, input);
};

export const resetPassword = (input: ResetPasswordInput) => {
  resetPasswordSchema.parse(input);
  return apiPost('/auth/reset-password', messageResponseSchema, input);
};
