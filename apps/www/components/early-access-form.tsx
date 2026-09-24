import { joinEarlyAccess } from "../app/early-access/actions";
import { ArrowRight } from "./primitives";
import { Button } from "./ui/button";

const FIELDS = [
  { name: "email", type: "email", placeholder: "Email Address", required: true },
  { name: "firstName", type: "text", placeholder: "First Name", required: false },
  { name: "lastName", type: "text", placeholder: "Last Name", required: false },
] as const;

/**
 * The early-access signup card. Rendered over the retro-office image in the
 * BookDemo section and on /early-access, which is also where the action
 * lands afterward — joined and error states are that page's to show.
 */
export function EarlyAccessForm({ error }: { error?: boolean }) {
  return (
    <form
      className="relative flex w-full max-w-[440px] flex-col gap-[22px] bg-cream p-[22px]"
      action={joinEarlyAccess}
    >
      <h2 className="text-24 text-ink">Get early access</h2>

      <div className="flex flex-col gap-3 p-0.5">
        <div className="flex flex-col gap-3">
          {error ? (
            <p className="text-12 text-[#a03c00]">
              That email address didn&apos;t look right — mind trying again?
            </p>
          ) : null}

          {FIELDS.map((f) => (
            <label key={f.name} className="block">
              <span className="sr-only">{f.placeholder}</span>
              <input
                name={f.name}
                type={f.type}
                placeholder={f.placeholder}
                required={f.required}
                className="h-12 w-full rounded-md bg-paper px-3 text-16 text-ink outline-none ring-1 ring-green"
              />
            </label>
          ))}

          <Button type="submit" size="lg" className="w-full">
            Join the list
            <ArrowRight size={16} />
          </Button>
        </div>

        <p className="text-10 text-ink">
          Pistachio runs on macOS and is in early preview. We will email you a
          download link when a build is ready for you. Your details are handled
          as described in our{" "}
          <a href="/privacy" className="underline hover:text-green">
            Privacy Policy
          </a>
          .
        </p>
      </div>
    </form>
  );
}
