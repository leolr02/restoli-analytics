"use client";

import { Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

export type AutocompleteOption = {
  value: string;
  label: string;
};

type AutocompleteSelectProps = {
  id: string;
  value: string;
  options: AutocompleteOption[];
  placeholder: string;
  disabled?: boolean;
  required?: boolean;
  clearOnSelect?: boolean;
  emptyMessage?: string;
  onChange: (value: string) => void;
};

function normalizeForSearch(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("es-MX");
}

export function AutocompleteSelect({
  id,
  value,
  options,
  placeholder,
  disabled = false,
  required = false,
  clearOnSelect = false,
  emptyMessage = "Sin coincidencias",
  onChange,
}: AutocompleteSelectProps) {
  const [query, setQuery] = useState("");
  const [isEditing, setIsEditing] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const selectedOption = options.find((option) => option.value === value);
  const listboxId = `${id}-options`;

  const filteredOptions = useMemo(() => {
    const normalizedQuery = normalizeForSearch(query.trim());
    if (!normalizedQuery) return options;

    return options.filter((option) =>
      normalizeForSearch(option.label).includes(normalizedQuery),
    );
  }, [options, query]);

  useEffect(() => {
    if (isEditing) return;
    setQuery(selectedOption?.label ?? "");
    setActiveIndex(0);
  }, [isEditing, selectedOption, value]);

  useEffect(() => {
    inputRef.current?.setCustomValidity(
      required && !selectedOption ? "Selecciona una opción de la lista." : "",
    );
  }, [required, selectedOption]);

  const selectOption = (option: AutocompleteOption) => {
    onChange(option.value);
    setQuery(clearOnSelect ? "" : option.label);
    setIsEditing(false);
    setIsOpen(false);
  };

  const setInitialActiveOption = (nextQuery: string) => {
    const normalizedQuery = normalizeForSearch(nextQuery.trim());
    const matches = normalizedQuery
      ? options.filter((option) =>
          normalizeForSearch(option.label).includes(normalizedQuery),
        )
      : options;
    const exactMatchIndex = matches.findIndex(
      (option) => normalizeForSearch(option.label) === normalizedQuery,
    );

    setActiveIndex(exactMatchIndex >= 0 ? exactMatchIndex : 0);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setIsOpen(true);
      setActiveIndex((index) =>
        Math.min(index + 1, Math.max(filteredOptions.length - 1, 0)),
      );
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      setIsOpen(true);
      setActiveIndex((index) => Math.max(index - 1, 0));
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      const activeOption = isOpen ? filteredOptions[activeIndex] : undefined;
      if (activeOption) selectOption(activeOption);
      return;
    }

    if (event.key === "Escape" && isOpen) {
      event.preventDefault();
      event.stopPropagation();
      setIsOpen(false);
    }
  };

  return (
    <div className="relative w-full">
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-base-content/50"
          aria-hidden="true"
        />
        <input
          ref={inputRef}
          id={id}
          type="text"
          role="combobox"
          className="input w-full border-base-300 bg-base-100 pl-9"
          value={query}
          placeholder={placeholder}
          disabled={disabled}
          required={required}
          autoComplete="off"
          aria-autocomplete="list"
          aria-haspopup="listbox"
          aria-expanded={isOpen && !disabled}
          aria-required={required}
          aria-controls={listboxId}
          aria-activedescendant={
            isOpen && filteredOptions[activeIndex]
              ? `${listboxId}-${filteredOptions[activeIndex].value}`
              : undefined
          }
          onChange={(event) => {
            const nextQuery = event.target.value;
            setQuery(nextQuery);
            setIsEditing(true);
            setIsOpen(true);
            onChange("");
            setInitialActiveOption(nextQuery);
          }}
          onFocus={() => {
            setIsOpen(true);
            setInitialActiveOption(query);
          }}
          onBlur={() => {
            setIsOpen(false);
            setIsEditing(false);
            setQuery(selectedOption?.label ?? "");
          }}
          onKeyDown={handleKeyDown}
        />
      </div>

      {isOpen && !disabled ? (
        <ul
          id={listboxId}
          role="listbox"
          className="absolute z-30 mt-1 max-h-60 w-full overflow-y-auto rounded-box border border-base-300 bg-base-100 p-1 shadow-lg"
        >
          {filteredOptions.length === 0 ? (
            <li
              role="option"
              aria-disabled="true"
              className="cursor-default px-3 py-2 text-sm text-base-content/60"
            >
              {emptyMessage}
            </li>
          ) : (
            filteredOptions.map((option, index) => (
              <li
                id={`${listboxId}-${option.value}`}
                key={option.value}
                role="option"
                aria-selected={option.value === value}
                className={`cursor-pointer rounded-field px-3 py-2 text-sm ${
                  index === activeIndex ? "bg-base-200" : "hover:bg-base-200"
                }`}
                onPointerDown={(event) => {
                  event.preventDefault();
                  selectOption(option);
                }}
              >
                {option.label}
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
