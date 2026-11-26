import { devLogin } from "./actions";

export default function DevLoginForm({
  status,
}: {
  status?: string;
}) {
  const inputStyle = {
    width: "100%",
    padding: "10px",
    border: "1px solid #cbd5e1",
    borderRadius: "6px",
    background: "#fff",
    color: "#0f172a",
    boxSizing: "border-box" as const,
  };

  return (
    <form
      action={devLogin}
      style={{ display: "grid", gap: "12px" }}
    >
      {status === "failed" && (
        <p role="alert">
          Unable to sign in. Check your username and password.
        </p>
      )}

      {status === "limited" && (
        <p role="alert">
          Sign-in attempts are temporarily limited.
          Please wait and try again.
        </p>
      )}

      <label htmlFor="dev-username">Username</label>
      <input
        id="dev-username"
        name="username"
        type="text"
        autoComplete="username"
        maxLength={100}
        style={inputStyle}
        required
      />

      <label htmlFor="dev-password">Password</label>
      <input
        id="dev-password"
        name="password"
        type="password"
        autoComplete="current-password"
        maxLength={1024}
        style={inputStyle}
        required
      />

      <button type="submit" className="cube-login-button">
        Sign in
      </button>
    </form>
  );
}