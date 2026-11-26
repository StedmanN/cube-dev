import { ChevronDown } from "lucide-react";
import { devLogout } from "./actions";

export default function DevUserMenu({ name }: { name: string }) {
  const initials = name
    .trim()
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <details style={{ position: "relative" }}>
      <summary
        className="ce-user"
        style={{
          cursor: "pointer",
          listStyle: "none",
        }}
      >
        <div className="ce-avatar">{initials}</div>
        <span className="ce-user-name">{name}</span>
        <ChevronDown size={17} />
      </summary>

      <form
        action={devLogout}
        style={{
          position: "absolute",
          top: "calc(100% + 12px)",
          right: 0,
          minWidth: "150px",
          padding: "6px",
          background: "#fff",
          border: "1px solid #e2e8f0",
          borderRadius: "8px",
          boxShadow: "0 8px 24px rgba(0, 0, 0, 0.15)",
          zIndex: 110,
        }}
      >
        <button
          type="submit"
          style={{
            width: "100%",
            padding: "10px 12px",
            border: 0,
            borderRadius: "4px",
            background: "#fff",
            color: "#111827",
            textAlign: "left",
            cursor: "pointer",
          }}
        >
          Log out
        </button>
      </form>
    </details>
  );
}