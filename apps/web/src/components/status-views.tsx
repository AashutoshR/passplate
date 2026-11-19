import { Link, type ErrorComponentProps } from "@tanstack/react-router";

export function NotFoundView() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center px-6">
      <p className="eyebrow text-oxblood">Not found</p>
      <h1 className="display mt-4 text-6xl">
        Not on the menu.
      </h1>
      <p className="mt-4 text-lg text-umber">That page or table code does not exist.</p>
      <div className="mt-8">
        <Link to="/" className="cta cta-dark px-6 py-3.5">
          <span>Back to PassPlate</span>
        </Link>
      </div>
    </main>
  );
}

export function ErrorView({ error, reset }: ErrorComponentProps) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center px-6">
      <p className="eyebrow text-oxblood">Something went wrong</p>
      <h1 className="display mt-4 text-6xl">
        Something burnt.
      </h1>
      <p className="mt-4 text-lg text-umber">{error instanceof Error ? error.message : "Please try again."}</p>
      <div className="mt-8">
        <button
          type="button"
          onClick={() => {
            reset();
            window.location.reload();
          }}
          className="cta cta-dark px-6 py-3.5"
        >
          <span>Try again</span>
        </button>
      </div>
    </main>
  );
}
