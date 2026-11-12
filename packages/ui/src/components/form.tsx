"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import type * as React from "react";
import {
  type Control,
  type ControllerFieldState,
  type ControllerRenderProps,
  type FieldPath,
  type FieldValues,
  FormProvider,
  type SubmitErrorHandler,
  type UseFormProps,
  type UseFormReturn,
  useController,
  useForm,
  useFormContext,
} from "react-hook-form";
import type { z } from "zod";
import { cn } from "../lib/utils";
import { Field, type FieldControlProps, type FieldProps } from "./field";

/** A zod schema whose input and output are both objects (the shape of a form). */
export type FormSchema = z.ZodType<FieldValues, FieldValues>;

/** The typed form returned by `useZodForm`. */
export type ZodForm<TSchema extends FormSchema> = UseFormReturn<z.input<TSchema>, unknown, z.output<TSchema>>;

/**
 * Creates a react-hook-form instance validated by a zod schema. Use it for every form; field
 * names, values and the submitted data are all typed from the schema.
 */
export function useZodForm<TInput extends FieldValues, TOutput extends FieldValues>(
  schema: z.ZodType<TOutput, TInput>,
  options?: Omit<UseFormProps<TInput, unknown, TOutput>, "resolver">,
): UseFormReturn<TInput, unknown, TOutput> {
  return useForm<TInput, unknown, TOutput>({
    mode: "onTouched",
    ...options,
    resolver: zodResolver<TInput, unknown, TOutput>(schema),
  });
}

export type FormProps<TInput extends FieldValues, TOutput extends FieldValues> = Omit<
  React.ComponentProps<"form">,
  "onSubmit" | "onInvalid"
> & {
  form: UseFormReturn<TInput, unknown, TOutput>;
  /** Called with the parsed values. If it throws, the message is shown by `FormError`. */
  onSubmit: (values: TOutput) => void | Promise<void>;
  onInvalid?: SubmitErrorHandler<TInput>;
};

/**
 * The form element plus the react-hook-form provider. Handles submit, and disables every control
 * inside it while the submit is running.
 */
export function Form<TInput extends FieldValues, TOutput extends FieldValues>({
  form,
  onSubmit,
  onInvalid,
  className,
  children,
  ...props
}: FormProps<TInput, TOutput>) {
  const submitting = form.formState.isSubmitting;

  async function submit(values: TOutput) {
    try {
      await onSubmit(values);
    } catch (err) {
      form.setError("root.submit", {
        type: "submit",
        message: err instanceof Error ? err.message : "Something went wrong. Try again.",
      });
    }
  }

  return (
    <FormProvider {...form}>
      <form
        noValidate
        aria-busy={submitting || undefined}
        className={className}
        onSubmit={form.handleSubmit(submit, onInvalid)}
        {...props}
      >
        <fieldset disabled={submitting} className="contents">
          {children}
        </fieldset>
      </form>
    </FormProvider>
  );
}

/** Shows the error thrown by the last submit, if any. Place it just above `FormActions`. */
export function FormError({ className }: { className?: string }) {
  const { formState } = useFormContext();
  const message = formState.errors.root?.submit?.message;
  if (!message) return null;
  return (
    <p role="alert" className={cn("rounded-md bg-danger-soft px-3 py-2 text-sm text-destructive", className)}>
      {message}
    </p>
  );
}

/** What a `FormField` render function receives: the field binding plus the Field wiring. */
export type FormFieldRenderProps<TInput extends FieldValues, TName extends FieldPath<TInput>> = {
  field: ControllerRenderProps<TInput, TName>;
  fieldState: ControllerFieldState;
  control: FieldControlProps;
};

export type FormFieldProps<
  TInput extends FieldValues,
  TName extends FieldPath<TInput>,
  TOutput extends FieldValues = TInput,
> = Omit<FieldProps, "children" | "error"> & {
  name: TName;
  /** Pass `form.control` so `name` and `field.value` are typed. Falls back to the surrounding `Form`. */
  control?: Control<TInput, unknown, TOutput>;
  children: (props: FormFieldRenderProps<TInput, TName>) => React.ReactNode;
};

/**
 * Connects one named field of a `Form` to a `Field`: label, hint, and the validation error from
 * the form state. Spread `field` and `control` onto the control in the render function.
 */
export function FormField<
  TInput extends FieldValues,
  TName extends FieldPath<TInput>,
  TOutput extends FieldValues = TInput,
>({ name, control, children, ...fieldProps }: FormFieldProps<TInput, TName, TOutput>) {
  const { field, fieldState } = useController<TInput, TName, TOutput>({ name, control });
  return (
    <Field {...fieldProps} error={fieldState.error?.message}>
      {(wiring) => children({ field, fieldState, control: wiring })}
    </Field>
  );
}
