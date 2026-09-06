import React, { forwardRef } from 'react'
import styles from './InputNumber.module.css'

export interface InputNumberProps {
  value?: number
  defaultValue?: number
  onChange?: (value: number | null) => void
  min?: number
  max?: number
  step?: number
  disabled?: boolean
  placeholder?: string
  className?: string
  style?: React.CSSProperties
}

export const InputNumber = forwardRef<HTMLInputElement, InputNumberProps>(
  (
    {
      value: controlledValue,
      defaultValue,
      onChange,
      min,
      max,
      step = 1,
      disabled = false,
      placeholder,
      className,
      style,
    },
    ref
  ) => {
    const [internalValue, setInternalValue] = React.useState<string>(
      defaultValue !== undefined ? String(defaultValue) : ''
    )
    // 受控时若用户输入的原文解析后与受控值相同（如 "0." 与 0），保留原文，避免小数点被吃掉
    const displayValue =
      controlledValue === undefined
        ? internalValue
        : internalValue !== '' && parseFloat(internalValue) === controlledValue
          ? internalValue
          : String(controlledValue)

    const clamp = (v: number): number => {
      if (min !== undefined && v < min) return min
      if (max !== undefined && v > max) return max
      return v
    }

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const raw = e.target.value
      setInternalValue(raw)
      if (raw === '' || raw === '-') {
        onChange?.(null)
        return
      }
      const num = parseFloat(raw)
      if (!isNaN(num)) {
        onChange?.(clamp(num))
      }
    }

    const stepValue = (direction: 1 | -1) => {
      const current = parseFloat(displayValue) || 0
      const next = clamp(current + step * direction)
      setInternalValue(String(next))
      onChange?.(next)
    }

    return (
      <div
        className={`${styles.wrapper} ${disabled ? styles.disabled : ''} ${className ?? ''}`}
        style={style}
      >
        <input
          ref={ref}
          type="text"
          inputMode="numeric"
          className={styles.input}
          value={displayValue}
          onChange={handleChange}
          disabled={disabled}
          placeholder={placeholder}
        />
        <div className={styles.controls}>
          <button
            type="button"
            className={styles.stepBtn}
            onClick={() => stepValue(1)}
            disabled={disabled}
            tabIndex={-1}
          >
            ▲
          </button>
          <button
            type="button"
            className={styles.stepBtn}
            onClick={() => stepValue(-1)}
            disabled={disabled}
            tabIndex={-1}
          >
            ▼
          </button>
        </div>
      </div>
    )
  }
)
InputNumber.displayName = 'InputNumber'
