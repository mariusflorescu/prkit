import { useNavigate } from "@tanstack/react-router";

import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";

import { fixtures } from "./fixtures";

const items = fixtures.map((fixture) => ({ value: fixture.name, label: fixture.label }));

export function FixturePicker({ selected }: { selected?: string }) {
  const navigate = useNavigate();
  return (
    <div className="flex items-center gap-3 text-xs text-muted-foreground">
      <span id="guide-fixture-label">Guide fixture</span>
      <Select<string>
        value={selected ?? null}
        items={items}
        onValueChange={(fixture) => {
          if (fixture !== null) void navigate({ to: "/dev/guide/$fixture", params: { fixture } });
        }}
      >
        <SelectTrigger aria-labelledby="guide-fixture-label" size="sm" className="w-48">
          <SelectValue placeholder="Choose a fixture" />
        </SelectTrigger>
        <SelectPopup alignItemWithTrigger={false}>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );
}
