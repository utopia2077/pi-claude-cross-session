import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		testTimeout: 30000,
		// The tests use only test-owned temporary directories and fake
		// sockets; they never touch the real registry or /tmp/cc-socks.
		env: { PI_OFFLINE: "1" },
	},
});
