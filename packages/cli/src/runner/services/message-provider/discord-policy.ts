import type { CanExecutePolicy, CanExecuteResult, InboundMessage } from "./types.js";
import type { Message, Role } from "discord.js";

/**
 * Create a CanExecutePolicy that checks Discord guild roles by ID.
 *
 * The policy extracts role IDs from the raw discord.js Message object
 * attached to InboundMessage.raw. If allowedRoles is empty or the
 * message is not a guild message (DM), the policy allows by default.
 *
 * Role names are intentionally NOT matched — they are mutable, can be
 * renamed or spoofed, and can differ across guilds. Role IDs are stable
 * and canonical within a guild.
 *
 * @param allowedRoles — Role IDs that grant access
 */
export function discordRoleAllowed(allowedRoles: string[]): CanExecutePolicy {
    return (message: InboundMessage): CanExecuteResult => {
        if (allowedRoles.length === 0) return { allowed: true };

        const raw = message.raw as Message | undefined;
        if (!raw || !raw.member) {
            // DM or uncached member — deny by default when roles are required
            return { allowed: false, reason: "Guild member not available (DM or uncached)" };
        }

        const memberRoles = raw.member.roles.cache;
        const roleIds = Array.from(memberRoles.values()).map((r: Role) => r.id);

        const hasMatch = allowedRoles.some(allowed =>
            roleIds.includes(allowed)
        );

        return hasMatch
            ? { allowed: true }
            : { allowed: false, reason: `User ${message.author.username} lacks required role ID: ${allowedRoles.join(", ")}` };
    };
}
