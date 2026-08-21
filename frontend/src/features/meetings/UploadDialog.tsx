import clsx from "clsx";
import { FileAudio, UploadCloud, X } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { useUploadMeeting } from "../../api/queries";
import { Button } from "../../components/ui/Button";
import { Field, Input } from "../../components/ui/controls";
import { Dialog } from "../../components/ui/Dialog";
import { ErrorState } from "../../components/ui/feedback";

/** Mirrors `config.ALLOWED_EXT`. The server rejects anything else with a 400. */
const ACCEPT = ".wav,.mp3,.m4a,.flac,.ogg,.webm,.mp4";

function sizeLabel(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function UploadDialog({
  open, onOpenChange,
}: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [title, setTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [percent, setPercent] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const uploadMeeting = useUploadMeeting(setPercent);

  const close = (next: boolean) => {
    if (uploadMeeting.isPending) return; // never abandon a request mid-flight
    if (!next) {
      setTitle("");
      setFile(null);
      setPercent(0);
      uploadMeeting.reset();
    }
    onOpenChange(next);
  };

  const submit = () => {
    if (!file) return;
    const form = new FormData();
    form.append("file", file);
    form.append("title", title.trim());
    setPercent(0);
    uploadMeeting.mutate(form, {
      onSuccess: (meeting) => {
        toast.success("업로드 완료", { description: `"${meeting.title}" 분석을 시작했습니다.` });
        close(false);
      },
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title="회의 음성 업로드"
      description="업로드하면 음성 인식과 화자 분리가 바로 시작됩니다."
      footer={
        <>
          <span className="flex-1 text-xs text-fg-muted">
            {uploadMeeting.isPending
              ? percent < 100
                ? `업로드 중 ${percent}%`
                : "서버에서 처리 중…"
              : "지원 형식: WAV, MP3, M4A, FLAC, OGG, WEBM, MP4"}
          </span>
          <Button size="sm" onClick={() => close(false)} disabled={uploadMeeting.isPending}>
            취소
          </Button>
          <Button
            size="sm"
            variant="primary"
            onClick={submit}
            disabled={!file}
            loading={uploadMeeting.isPending}
          >
            업로드
          </Button>
        </>
      }
    >
      <Field label="회의 제목" hint="비워 두면 파일 이름을 그대로 씁니다.">
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="예: 8월 3주차 개발 회의"
          disabled={uploadMeeting.isPending}
        />
      </Field>

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        className="sr-only"
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
      />

      {file ? (
        <div className="flex items-center gap-2.5 rounded-md border border-border bg-surface-muted px-3 py-2.5">
          <FileAudio aria-hidden className="size-4 shrink-0 text-primary" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm text-fg">{file.name}</p>
            <p className="text-xs text-fg-muted">{sizeLabel(file.size)}</p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            aria-label="선택한 파일 제거"
            disabled={uploadMeeting.isPending}
            onClick={() => {
              setFile(null);
              if (inputRef.current) inputRef.current.value = "";
            }}
            icon={<X className="size-4" />}
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            setFile(e.dataTransfer.files?.[0] ?? null);
          }}
          className={clsx(
            "flex w-full flex-col items-center gap-1.5 rounded-md border border-dashed px-4 py-8 transition-colors",
            dragging ? "border-primary bg-primary-soft" : "border-border-strong hover:bg-surface-muted",
          )}
        >
          <UploadCloud aria-hidden className="size-6 text-fg-subtle" />
          <span className="text-sm font-medium text-fg">파일을 끌어다 놓거나 클릭해서 선택</span>
          <span className="text-xs text-fg-muted">한 번에 한 개</span>
        </button>
      )}

      {uploadMeeting.isPending ? (
        <div
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="업로드 진행률"
          className="h-1.5 w-full overflow-hidden rounded-full bg-surface-muted"
        >
          <div
            className="h-full rounded-full bg-primary transition-[width]"
            style={{ width: `${percent}%` }}
          />
        </div>
      ) : null}

      {uploadMeeting.isError ? <ErrorState error={uploadMeeting.error} /> : null}
    </Dialog>
  );
}
