/**
 * Shared types for the test server harness.
 */

export interface TestServerOptions {
    /** Override base URL (default: auto from port) */
    baseUrl?: string;
    /** Extra trusted origins for CORS */
    trustedOrigins?: string[];
    /** Disable signup-after-first-user restriction (default: true = disabled) */
    disableSignupAfterFirstUser?: boolean;
}

export interface TestServer {
    /** Ephemeral port the server is listening on */
    port: number;
    /** Base URL: http://localhost:{port} */
    baseUrl: string;
    /** The Socket.IO server instance */
    io: import("socket.io").Server;
    /** Pre-created API key for auth */
    apiKey: string;
    /** Pre-created test user's ID */
    userId: string;
    /** Pre-created test user's name */
    userName: string;
    /** Pre-created test user's email */
    userEmail: string;
    /** Auth session cookie string for viewer/hub namespaces */
    sessionCookie: string;
    /** Helper: make an authenticated REST request */
    fetch(path: string, init?: RequestInit): Promise<Response>;
    /** Shut down everything and clean up */
    cleanup(): Promise<void>;
}
