import { redirect } from "next/navigation";

/** Settings is a group in the rail; its first page is the account. */
export default function SettingsIndex(): never {
  redirect("/app/settings/account");
}
