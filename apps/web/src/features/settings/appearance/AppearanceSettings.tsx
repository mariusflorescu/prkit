import { ListError } from "~/components/ListError";

import { FailedSave } from "../FailedSave";
import { SettingsSection } from "../SettingsSection";
import { THEME_OPTIONS } from "./themeOptions";
import { ThemeCard } from "./ThemeCard";
import { ThemeCardsSkeleton } from "./ThemeCardsSkeleton";
import { useAppearance } from "./useAppearance";

/** Settings > Appearance: System, Light or Dark, applied the moment a card is picked. */
export function AppearanceSettings() {
  const { appearance, update, saving } = useAppearance();
  return (
    <SettingsSection
      title="Appearance"
      description="Theme. System follows your device's light or dark appearance."
    >
      {appearance.isPending ? (
        <ThemeCardsSkeleton />
      ) : appearance.isError ? (
        <ListError
          title="Couldn't load your appearance"
          message={appearance.error.message}
          retry={() => void appearance.refetch()}
        />
      ) : (
        <>
          <div role="radiogroup" aria-label="Theme" className="mt-4 grid grid-cols-3 gap-3">
            {THEME_OPTIONS.map((option) => (
              <ThemeCard
                key={option.value}
                value={option.value}
                label={option.label}
                tones={option.tones}
                selected={appearance.data.theme === option.value}
                saving={saving}
                onSelect={(theme) => update.mutate(theme)}
              />
            ))}
          </div>
          <FailedSave save={update} />
        </>
      )}
    </SettingsSection>
  );
}
