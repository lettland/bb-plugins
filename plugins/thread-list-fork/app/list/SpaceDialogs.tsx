import { useId, useState, type FormEvent, type RefObject } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { RenameDialog, useNameValidation } from "@/components/ui/rename-dialog";

export const SPACE_BRIEF_MAX_LENGTH = 20_000;

const BRIEF_TEXTAREA_CLASS =
  "min-h-40 w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

interface SpaceBriefFieldProps {
  disabled: boolean;
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
}

function SpaceBriefField({
  disabled,
  id,
  label,
  value,
  onChange,
}: SpaceBriefFieldProps) {
  return (
    <div className="space-y-1">
      <textarea
        id={id}
        aria-label={label}
        className={BRIEF_TEXTAREA_CLASS}
        value={value}
        maxLength={SPACE_BRIEF_MAX_LENGTH}
        disabled={disabled}
        spellCheck
        onChange={(event) => onChange(event.target.value)}
      />
      <p
        className="text-right text-sm text-muted-foreground"
        data-testid="space-brief-counter"
      >
        {value.length} / {SPACE_BRIEF_MAX_LENGTH}
      </p>
    </div>
  );
}

interface SpaceCreateDialogProps {
  errorMessage: string | null;
  open: boolean;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (input: { name: string; brief: string }) => void;
}

export function SpaceCreateDialog({
  errorMessage,
  open,
  pending,
  onOpenChange,
  onCreate,
}: SpaceCreateDialogProps) {
  return (
    <RenameDialog open={open} onOpenChange={onOpenChange}>
      {(inputRef) =>
        open ? (
          <SpaceCreateDialogContent
            errorMessage={errorMessage}
            pending={pending}
            onCreate={onCreate}
            inputRef={inputRef}
          />
        ) : null
      }
    </RenameDialog>
  );
}

function SpaceCreateDialogContent({
  errorMessage,
  pending,
  onCreate,
  inputRef,
}: {
  errorMessage: string | null;
  pending: boolean;
  onCreate: (input: { name: string; brief: string }) => void;
  inputRef: RefObject<HTMLInputElement | null>;
}) {
  const nameId = useId();
  const briefId = useId();
  const [name, setName] = useState("");
  const [brief, setBrief] = useState("");
  const { validationMessage, validate, clearMessage } = useNameValidation({
    emptyMessage: "Space name cannot be empty.",
  });
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    const trimmedName = validate(name);
    if (trimmedName === null) return;
    onCreate({ name: trimmedName, brief });
  };
  const message = validationMessage ?? errorMessage;
  return (
    <>
      <DialogHeader>
        <DialogTitle>New Space</DialogTitle>
        <DialogDescription>
          A Space groups threads from any project and shares its brief with
          them.
        </DialogDescription>
      </DialogHeader>
      <form className="space-y-4" onSubmit={handleSubmit}>
        <div className="space-y-2">
          <Input
            ref={inputRef}
            id={nameId}
            aria-label="Space name"
            value={name}
            autoCapitalize="sentences"
            autoCorrect="off"
            spellCheck={false}
            disabled={pending}
            onChange={(event) => {
              setName(event.target.value);
              clearMessage();
            }}
          />
          <SpaceBriefField
            id={briefId}
            label="Brief (optional)"
            value={brief}
            disabled={pending}
            onChange={setBrief}
          />
          {message ? (
            <p role="alert" className="text-sm text-destructive">
              {message}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button type="submit" disabled={pending}>
            Create Space
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}

export interface SpaceBriefTarget {
  id: string;
  name: string;
  brief: string;
}

interface SpaceBriefDialogProps {
  errorMessage: string | null;
  pending: boolean;
  space: SpaceBriefTarget | null;
  onCancel: () => void;
  onSave: (brief: string) => void;
}

export function SpaceBriefDialog({
  errorMessage,
  pending,
  space,
  onCancel,
  onSave,
}: SpaceBriefDialogProps) {
  return (
    <Dialog
      open={space !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent>
        {space ? (
          <SpaceBriefDialogContent
            key={space.id}
            errorMessage={errorMessage}
            pending={pending}
            space={space}
            onCancel={onCancel}
            onSave={onSave}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function SpaceBriefDialogContent({
  errorMessage,
  pending,
  space,
  onCancel,
  onSave,
}: {
  errorMessage: string | null;
  pending: boolean;
  space: SpaceBriefTarget;
  onCancel: () => void;
  onSave: (brief: string) => void;
}) {
  const briefId = useId();
  const [brief, setBrief] = useState(space.brief);
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    onSave(brief);
  };
  return (
    <>
      <DialogHeader>
        <DialogTitle>Edit brief</DialogTitle>
        <DialogDescription>
          Every thread in {space.name} receives this brief.
        </DialogDescription>
      </DialogHeader>
      <form className="space-y-4" onSubmit={handleSubmit}>
        <SpaceBriefField
          id={briefId}
          label={`Brief for ${space.name}`}
          value={brief}
          disabled={pending}
          onChange={setBrief}
        />
        {errorMessage ? (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={onCancel}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={pending}>
            Save
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}
