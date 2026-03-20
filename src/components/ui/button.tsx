import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "btn",
  {
    variants: {
      variant: {
        default: "btn--default",
        outline: "btn--outline",
        secondary: "btn--secondary",
        ghost: "btn--ghost",
        destructive: "btn--destructive",
        link: "btn--link",
      },
      size: {
        default: "btn--default",
        xs: "btn--xs",
        sm: "btn--sm",
        lg: "btn--lg",
        icon: "btn--icon",
        "icon-xs": "btn--icon-xs",
        "icon-sm": "btn--icon-sm",
        "icon-lg": "btn--icon-lg",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
