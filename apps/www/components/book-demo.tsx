import { EarlyAccessForm } from "./early-access-form";

export function BookDemo() {
  return (
    <section className="mx-auto w-full max-w-[1512px] p-4 desk:p-6">
      <div className="relative flex items-center justify-center px-4 py-20 desk:px-0">
        <img
          src="/img/early-access-agent-desk.webp"
          alt=""
          className="absolute inset-0 size-full object-cover"
        />

        <EarlyAccessForm />
      </div>
    </section>
  );
}
