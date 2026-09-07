import { useVirtualizer } from "@tanstack/react-virtual"
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react"
import { rankModels } from "../lib/model-search"

interface ModelComboboxProps {
  value: string
  options: string[]
  onChange(value: string): void
  ariaLabel: string
  automaticLabel: string
  placeholder: string
  noResultsLabel: string
  unavailableLabel: string
  allowAutomatic?: boolean
  excluded?: string[]
  disabled?: boolean
}

interface ComboboxItem {
  id: string
  provider: string
  name: string
  unavailable?: boolean
  automatic?: boolean
}

export function ModelCombobox({
  value,
  options,
  onChange,
  ariaLabel,
  automaticLabel,
  placeholder,
  noResultsLabel,
  unavailableLabel,
  allowAutomatic = false,
  excluded = [],
  disabled = false,
}: ModelComboboxProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const listId = useId()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [activeIndex, setActiveIndex] = useState(0)
  const optionSet = useMemo(() => new Set(options), [options])

  const items = useMemo<ComboboxItem[]>(() => {
    const blocked = new Set(excluded.filter((id) => id !== value))
    const source = value && !optionSet.has(value) ? [value, ...options] : options
    const ranked = rankModels(source.filter((id) => !blocked.has(id)), query).map((model) => ({
      id: model.id,
      provider: model.provider,
      name: model.name,
      unavailable: !optionSet.has(model.id),
    }))
    const automaticMatches = !query.trim() || automaticLabel.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
    return allowAutomatic && automaticMatches
      ? [{ id: "", provider: "", name: automaticLabel, automatic: true }, ...ranked]
      : ranked
  }, [allowAutomatic, automaticLabel, excluded, optionSet, options, query, value])

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 48,
    overscan: 4,
  })

  useEffect(() => {
    setActiveIndex((index) => Math.min(index, Math.max(0, items.length - 1)))
  }, [items.length])

  const close = () => {
    setOpen(false)
    setQuery("")
  }

  const choose = (item: ComboboxItem | undefined) => {
    if (!item) return
    onChange(item.id)
    close()
  }

  const move = (direction: 1 | -1) => {
    if (!open) {
      setOpen(true)
      setQuery("")
    }
    if (items.length === 0) return
    const next = (activeIndex + direction + items.length) % items.length
    setActiveIndex(next)
    virtualizer.scrollToIndex(next, { align: "auto" })
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault()
      move(1)
    } else if (event.key === "ArrowUp") {
      event.preventDefault()
      move(-1)
    } else if (event.key === "Enter" && open) {
      event.preventDefault()
      choose(items[activeIndex])
    } else if (event.key === "Escape" && open) {
      event.preventDefault()
      close()
    }
  }

  const virtualItems = virtualizer.getVirtualItems()
  const selectedUnavailable = Boolean(value && !optionSet.has(value))

  return (
    <div
      className="model-combobox"
      ref={rootRef}
      onBlur={(event) => {
        if (!rootRef.current?.contains(event.relatedTarget as Node | null)) close()
      }}
    >
      <div className="model-combobox-input-wrap">
        <input
          ref={inputRef}
          role="combobox"
          aria-label={ariaLabel}
          aria-controls={listId}
          aria-expanded={open}
          aria-autocomplete="list"
          aria-activedescendant={open && items[activeIndex] ? `${listId}-${activeIndex}` : undefined}
          value={open ? query : value || automaticLabel}
          placeholder={placeholder}
          disabled={disabled}
          onFocus={() => {
            setQuery("")
            setOpen(true)
            setActiveIndex(0)
          }}
          onChange={(event) => {
            setQuery(event.target.value)
            setOpen(true)
            setActiveIndex(0)
          }}
          onKeyDown={onKeyDown}
        />
        <button
          type="button"
          className="model-combobox-toggle"
          aria-label={ariaLabel}
          tabIndex={-1}
          disabled={disabled}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            setQuery("")
            setOpen(true)
            inputRef.current?.focus()
          }}
        >⌄</button>
      </div>
      {selectedUnavailable && !open && <small className="model-combobox-warning">{unavailableLabel}</small>}
      {open && (
        <div className="model-combobox-popup">
          <div ref={scrollRef} id={listId} role="listbox" className="model-combobox-list">
            {items.length === 0 ? (
              <div className="model-combobox-empty">{noResultsLabel}</div>
            ) : (
              <div className="model-combobox-virtual" style={{ height: virtualizer.getTotalSize() }}>
                {virtualItems.map((row) => {
                  const item = items[row.index]!
                  const selected = item.id === value
                  return (
                    <button
                      type="button"
                      id={`${listId}-${row.index}`}
                      role="option"
                      aria-selected={selected}
                      className="model-combobox-option"
                      data-active={row.index === activeIndex || undefined}
                      data-selected={selected || undefined}
                      key={item.automatic ? "automatic" : item.id}
                      style={{ transform: `translateY(${row.start}px)`, height: row.size }}
                      onMouseDown={(event) => event.preventDefault()}
                      onMouseEnter={() => setActiveIndex(row.index)}
                      onClick={() => choose(item)}
                    >
                      {item.automatic ? (
                        <span className="model-combobox-automatic">{item.name}</span>
                      ) : (
                        <>
                          <span className="model-combobox-provider">{item.provider}</span>
                          <span className="model-combobox-name">{item.name}</span>
                          {item.unavailable && <span className="model-combobox-unavailable">{unavailableLabel}</span>}
                        </>
                      )}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
