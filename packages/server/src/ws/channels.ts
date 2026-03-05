// ============================================================================
// channels.ts — In-memory channel manager for multi-agent coordination
//
// Channels are named groups that sessions can join/leave. Messages broadcast
// to a channel are delivered to all members except the sender.
//
// Per AD-3: Channels use in-memory maps on each server instance. Channel
// membership is ephemeral — lost on server restart. Agents re-register on
// reconnect.
//
// Redis pub/sub for cross-server sync is reserved for future multi-server
// deployments (see subscribe() stub).
// ============================================================================

import type { Socket } from "socket.io";

export type BroadcastFn = (
    targetSessionId: string,
    event: string,
    data: unknown,
) => void;

export class ChannelManager {
    /** channelId → Set of sessionIds */
    private channels = new Map<string, Set<string>>();

    /** sessionId → Set of channelIds (reverse index for fast disconnect cleanup) */
    private sessionChannels = new Map<string, Set<string>>();

    /**
     * Add a session to a channel.
     * Returns the current list of members after the join.
     */
    join(channelId: string, sessionId: string): string[] {
        // Add to channel → sessions map
        if (!this.channels.has(channelId)) {
            this.channels.set(channelId, new Set());
        }
        this.channels.get(channelId)!.add(sessionId);

        // Add to session → channels reverse index
        if (!this.sessionChannels.has(sessionId)) {
            this.sessionChannels.set(sessionId, new Set());
        }
        this.sessionChannels.get(sessionId)!.add(channelId);

        return this.getMembers(channelId);
    }

    /**
     * Remove a session from a channel.
     * Returns the current list of members after the leave, or null if channel
     * was empty and deleted.
     */
    leave(channelId: string, sessionId: string): string[] | null {
        const members = this.channels.get(channelId);
        if (!members) return null;

        members.delete(sessionId);

        // Remove from reverse index
        const chans = this.sessionChannels.get(sessionId);
        if (chans) {
            chans.delete(channelId);
            if (chans.size === 0) {
                this.sessionChannels.delete(sessionId);
            }
        }

        // Clean up empty channel
        if (members.size === 0) {
            this.channels.delete(channelId);
            return null;
        }

        return Array.from(members);
    }

    /**
     * Get all member session IDs for a channel.
     */
    getMembers(channelId: string): string[] {
        const members = this.channels.get(channelId);
        return members ? Array.from(members) : [];
    }

    /**
     * Check if a session is a member of a channel.
     */
    isMember(channelId: string, sessionId: string): boolean {
        return this.channels.get(channelId)?.has(sessionId) ?? false;
    }

    /**
     * Get all channel IDs a session belongs to.
     */
    getChannelsForSession(sessionId: string): string[] {
        const chans = this.sessionChannels.get(sessionId);
        return chans ? Array.from(chans) : [];
    }

    /**
     * Remove a session from all channels it belongs to.
     * Returns a map of channelId → remaining members for each channel
     * that was affected (useful for broadcasting leave notifications).
     */
    removeFromAll(sessionId: string): Map<string, string[]> {
        const affected = new Map<string, string[]>();
        const chans = this.sessionChannels.get(sessionId);

        if (!chans) return affected;

        for (const channelId of chans) {
            const members = this.channels.get(channelId);
            if (!members) continue;

            members.delete(sessionId);

            if (members.size === 0) {
                this.channels.delete(channelId);
                // Channel is now empty — no members to notify
            } else {
                affected.set(channelId, Array.from(members));
            }
        }

        this.sessionChannels.delete(sessionId);
        return affected;
    }

    /**
     * Get all members of a channel except the specified session.
     * Used for broadcasting messages to other members.
     */
    getOtherMembers(channelId: string, excludeSessionId: string): string[] {
        const members = this.channels.get(channelId);
        if (!members) return [];
        return Array.from(members).filter((id) => id !== excludeSessionId);
    }

    /**
     * Get the total number of channels.
     */
    get channelCount(): number {
        return this.channels.size;
    }

    /**
     * Get the total number of sessions across all channels (unique).
     */
    get sessionCount(): number {
        return this.sessionChannels.size;
    }
}
