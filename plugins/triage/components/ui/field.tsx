import * as React from "react";

import { cn } from "../../lib/utils";

/** Vertical label + control + hint stack shared by every Triage form. */
function Field({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("bb-field", className)} {...props} />;
}

function FieldLabel({
  className,
  optional,
  children,
  ...props
}: React.LabelHTMLAttributes<HTMLLabelElement> & { optional?: boolean }) {
  return (
    <label className={cn("bb-field-label", className)} {...props}>
      {children}
      {optional ? <span className="bb-field-optional">(Optional)</span> : null}
    </label>
  );
}

function FieldHint({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("bb-field-hint", className)} {...props} />;
}

/** Two fields side by side on wide dialogs, stacked on narrow ones. */
function FieldRow({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("bb-field-row", className)} {...props} />;
}

/** Grouped section inside a long form, with its own quiet heading. */
function FieldGroup({
  title,
  description,
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { title: string; description?: string }) {
  return (
    <section className={cn("bb-field-group", className)} {...props}>
      <header className="bb-field-group-header">
        <h3 className="bb-field-group-title">{title}</h3>
        {description ? <p className="bb-field-group-description">{description}</p> : null}
      </header>
      {children}
    </section>
  );
}

export { Field, FieldGroup, FieldHint, FieldLabel, FieldRow };
