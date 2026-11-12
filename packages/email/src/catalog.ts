import type { ComponentType } from "react";
import ExistingAccount, { type ExistingAccountProps } from "./templates/existing-account";
import ResetPassword, { type ResetPasswordProps } from "./templates/reset-password";
import TeamInvitation, { type TeamInvitationProps } from "./templates/team-invitation";
import VerifyCode, { type VerifyCodeProps } from "./templates/verify-code";

/*
 * Every email Relay sends, in one list. To add one: write a template in ./templates,
 * add its data type to EmailData and an entry here. Nothing can be sent that is not listed.
 */

export type EmailData = {
  "verify-code": VerifyCodeProps;
  "reset-password": ResetPasswordProps;
  "team-invitation": TeamInvitationProps;
  "existing-account": ExistingAccountProps;
};

export type EmailKind = keyof EmailData;

type Definition<K extends EmailKind> = {
  template: ComponentType<EmailData[K]>;
  subject: (data: EmailData[K]) => string;
  /**
   * Account emails (codes, resets) matter only for minutes: retry briefly. Others can wait.
   * Also decides which emails a person can never unsubscribe from.
   */
  category: "account" | "team" | "product";
};

export const catalog: { [K in EmailKind]: Definition<K> } = {
  "verify-code": {
    template: VerifyCode,
    subject: (d) => `${d.code} is your Relay code`,
    category: "account",
  },
  "reset-password": {
    template: ResetPassword,
    subject: () => "Reset your Relay password",
    category: "account",
  },
  "team-invitation": {
    template: TeamInvitation,
    subject: (d) => `${d.inviterName} invited you to ${d.organizationName} on Relay`,
    category: "team",
  },
  "existing-account": {
    template: ExistingAccount,
    subject: () => "You already have a Relay account",
    category: "account",
  },
};
