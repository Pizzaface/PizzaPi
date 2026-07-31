// Skills management socket.io handlers, split out of daemon.ts's runDaemon().
import type { Socket } from "socket.io-client";
import { scanGlobalSkills, readSkillContent, writeSkill, deleteSkill } from "../../skills.js";

export function registerSkillsHandlers(socket: Socket, isShuttingDown: () => boolean): void {
    socket.on("list_skills", (data: any) => {
        if (isShuttingDown()) return;
        const requestId = data.requestId;
        const skills = scanGlobalSkills();
        socket.emit("skills_list", { skills, requestId });
    });

    socket.on("create_skill", async (data: any) => {
        if (isShuttingDown()) return;
        const requestId = data.requestId;
        const skillName = (data.name ?? "").trim();
        const skillContent = data.content ?? "";

        if (!skillName) {
            socket.emit("skill_result", { requestId, ok: false, message: "Missing skill name" });
            return;
        }

        if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(skillName) && !/^[a-z0-9]$/.test(skillName)) {
            socket.emit("skill_result", {
                requestId,
                ok: false,
                message: "Invalid skill name: must be lowercase letters, numbers, and hyphens only",
            });
            return;
        }

        try {
            await writeSkill(skillName, skillContent);
            const skills = scanGlobalSkills();
            socket.emit("skill_result", { requestId, ok: true, skills });
        } catch (err) {
            socket.emit("skill_result", {
                requestId,
                ok: false,
                message: err instanceof Error ? err.message : String(err),
            });
        }
    });

    socket.on("update_skill", async (data: any) => {
        if (isShuttingDown()) return;
        const requestId = data.requestId;
        const skillName = (data.name ?? "").trim();
        const skillContent = data.content ?? "";

        if (!skillName) {
            socket.emit("skill_result", { requestId, ok: false, message: "Missing skill name" });
            return;
        }

        if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(skillName) && !/^[a-z0-9]$/.test(skillName)) {
            socket.emit("skill_result", {
                requestId,
                ok: false,
                message: "Invalid skill name: must be lowercase letters, numbers, and hyphens only",
            });
            return;
        }

        try {
            await writeSkill(skillName, skillContent);
            const skills = scanGlobalSkills();
            socket.emit("skill_result", { requestId, ok: true, skills });
        } catch (err) {
            socket.emit("skill_result", {
                requestId,
                ok: false,
                message: err instanceof Error ? err.message : String(err),
            });
        }
    });

    socket.on("delete_skill", (data: any) => {
        if (isShuttingDown()) return;
        const requestId = data.requestId;
        const skillName = (data.name ?? "").trim();

        if (!skillName) {
            socket.emit("skill_result", { requestId, ok: false, message: "Missing skill name" });
            return;
        }

        const deleted = deleteSkill(skillName);
        const skills = scanGlobalSkills();
        socket.emit("skill_result", {
            requestId,
            ok: deleted,
            message: deleted ? undefined : "Skill not found",
            skills,
        });
    });

    socket.on("get_skill", (data: any) => {
        if (isShuttingDown()) return;
        const requestId = data.requestId;
        const skillName = (data.name ?? "").trim();
        const content = skillName ? readSkillContent(skillName) : null;
        if (content === null) {
            socket.emit("skill_result", { requestId, ok: false, message: "Skill not found" });
        } else {
            socket.emit("skill_result", { requestId, ok: true, name: skillName, content });
        }
    });
}
