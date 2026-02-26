import * as React from "react";
import { ListTodoIcon, CircleDashedIcon, CircleDotIcon, CheckCircle2Icon, XCircleIcon as XCircleIcon2 } from "lucide-react";
import {
  ToolCardShell,
  ToolCardHeader,
  ToolCardTitle,
} from "@/components/ui/tool-card";
import { PizzaProgress } from "@/components/session-viewer/cards/PizzaProgress";

export interface TodoItem {
  id: number;
  text: string;
  status: "pending" | "in_progress" | "done" | "cancelled";
}

export function TodoCard({ todos }: { todos: TodoItem[] }) {
  const done = todos.filter((t) => t.status === "done").length;
  const total = todos.length;

  const statusIcon = (status: TodoItem["status"]) => {
    switch (status) {
      case "done":
        return <CheckCircle2Icon className="size-3.5 shrink-0 text-emerald-500" />;
      case "in_progress":
        return <CircleDotIcon className="size-3.5 shrink-0 text-blue-400 animate-pulse" />;
      case "cancelled":
        return <XCircleIcon2 className="size-3.5 shrink-0 text-zinc-500" />;
      default:
        return <CircleDashedIcon className="size-3.5 shrink-0 text-zinc-500" />;
    }
  };

  return (
    <ToolCardShell>
      <ToolCardHeader>
        <ToolCardTitle icon={<ListTodoIcon className="size-4 shrink-0 text-zinc-400" />}>
          <span className="text-sm font-medium text-zinc-400">Tasks</span>
        </ToolCardTitle>
        <span className="text-[11px] text-zinc-500 tabular-nums">
          {done}/{total} done
        </span>
      </ToolCardHeader>
      {/* Pizza progress + todo list: vertical on mobile, horizontal on desktop */}
      <div className="flex flex-col md:flex-row">
        <div className="border-b md:border-b-0 md:border-r border-zinc-800/60 md:flex md:items-center md:px-2">
          <PizzaProgress done={done} total={total} />
        </div>
        <ul className="divide-y divide-zinc-800/60 md:flex-1">
        {todos.map((item) => (
          <li
            key={item.id}
            className={`flex items-start gap-2.5 px-4 py-2 ${
              item.status === "done" || item.status === "cancelled"
                ? "opacity-60"
                : ""
            }`}
          >
            <span className="mt-0.5">{statusIcon(item.status)}</span>
            <span
              className={`text-xs leading-relaxed ${
                item.status === "done"
                  ? "line-through text-zinc-500"
                  : item.status === "cancelled"
                    ? "line-through text-zinc-600"
                    : item.status === "in_progress"
                      ? "text-zinc-200"
                      : "text-zinc-400"
              }`}
            >
              {item.text}
            </span>
          </li>
        ))}
        </ul>
      </div>
    </ToolCardShell>
  );
}
