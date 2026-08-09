import { TODO_STATUS_ICON, type TodoItem } from "./types";

interface PlanListProps {
  plan: TodoItem[];
}

export function PlanList({ plan }: PlanListProps) {
  if (plan.length === 0) return null;
  return (
    <ul className="rounded-md bg-slate-100 p-2 text-xs dark:bg-slate-900">
      {plan.map((todo, i) => (
        <li
          key={i}
          className={
            todo.status === "completed"
              ? "text-slate-500 line-through"
              : todo.status === "in_progress"
                ? "text-blue-700 dark:text-blue-300"
                : "text-slate-600 dark:text-slate-300"
          }
        >
          {TODO_STATUS_ICON[todo.status]} {todo.content}
        </li>
      ))}
    </ul>
  );
}
