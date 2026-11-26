import "server-only";

import type { Session } from "next-auth";

export const localSession = {
  expires: "2099-12-31T23:59:59.999Z",
  user: {
    id: "local-dev-user",
    name: "Stedman Newnam",
    email: "local@localhost",
    groups: ["Developer"],
  },
} satisfies Session;
