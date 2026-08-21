import clsx from "clsx";
import { Check, UserRound } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { useRenameSpeaker, useSetMySpeaker } from "../../api/queries";
import type { Speaker } from "../../api/types";
import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/controls";
import { speakerColors } from "../../lib/speakers";

/**
 * Renaming stops at the review gate because it changes the minutes — approved
 * chunks already render the display names. Claiming a speaker as yourself does
 * not, so it stays available afterwards.
 */
export function SpeakerBar({
  meetingId, speakers, editable, mySpeakerId,
}: {
  meetingId: number;
  speakers: Speaker[];
  editable: boolean;
  mySpeakerId: number | null;
}) {
  const colors = speakerColors(speakers);
  const rename = useRenameSpeaker(meetingId);
  const setMine = useSetMySpeaker(meetingId);

  if (speakers.length === 0) {
    return <p className="text-xs text-fg-muted">아직 화자가 분리되지 않았습니다.</p>;
  }

  return (
    <div className="flex flex-wrap gap-2.5">
      {speakers.map((s) => {
        const mine = s.id === mySpeakerId;
        return (
          <div
            key={s.id}
            className="flex items-center gap-1.5 rounded-md border border-border bg-surface py-1 pr-1 pl-2"
            style={{ borderLeft: `3px solid ${colors.get(s.speaker_code)}` }}
          >
            <SpeakerName
              key={s.display_name ?? s.speaker_code}
              speaker={s}
              editable={editable}
              onRename={(display_name) =>
                rename.mutate(
                  { speakerId: s.id, display_name },
                  { onError: (err) => toast.error("이름 변경 실패", { description: err.message }) },
                )
              }
            />
            <Button
              size="sm"
              variant={mine ? "primary" : "ghost"}
              aria-pressed={mine}
              title={mine ? "이 화자 지정을 해제합니다." : "이 화자를 나로 지정합니다."}
              icon={mine ? <Check className="size-3.5" /> : <UserRound className="size-3.5" />}
              onClick={() =>
                setMine.mutate(mine ? null : s.id, {
                  onSuccess: () =>
                    toast.success(mine ? "나로 지정을 해제했습니다." : "나로 지정했습니다."),
                  onError: (err) => toast.error("화자 지정 실패", { description: err.message }),
                })
              }
            >
              {mine ? "나" : "나로 지정"}
            </Button>
          </div>
        );
      })}
    </div>
  );
}

function SpeakerName({
  speaker, editable, onRename,
}: { speaker: Speaker; editable: boolean; onRename: (name: string) => void }) {
  const initial = speaker.display_name || speaker.speaker_code;
  const [name, setName] = useState(initial);

  if (!editable) {
    return (
      <span className="px-1 text-sm font-medium text-fg" title={speaker.speaker_code}>
        {initial}
      </span>
    );
  }
  return (
    <Input
      value={name}
      aria-label={`${speaker.speaker_code} 이름`}
      title={speaker.speaker_code}
      className={clsx("h-7 w-28 border-transparent px-1 text-sm font-medium hover:border-border")}
      onChange={(e) => setName(e.target.value)}
      onBlur={() => name.trim() && name !== initial && onRename(name.trim())}
    />
  );
}
