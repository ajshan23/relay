"use client";

import { Field } from "@relay/ui/components/field";
import { Icon } from "@relay/ui/components/icon";
import { Modal } from "@relay/ui/components/modal";
import { TextInput } from "@relay/ui/components/text-input";
import { Button } from "@relay/ui/ui/button";
import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import { inBranch } from "@/components/contacts/queries";
import { useBranch } from "@/components/shell/branch-context";
import { ApiError, api } from "@/lib/api";
import type { Pin } from "./location-map";

/*
 * Choose the place a "Send location" step sends: search for it, paste a Google Maps link (short links
 * too) or coordinates, or drop the pin on the map. Moving the pin looks up the address there, which
 * can still be edited.
 */

const LocationMap = dynamic(() => import("./location-map"), {
  ssr: false,
  loading: () => <div className="h-full w-full animate-pulse rounded-md bg-muted" />,
});

export type ChosenLocation = { latitude: number; longitude: number; name: string; address: string };
type Place = { name: string; address: string; latitude: number; longitude: number };

const round = (n: number) => Math.round(n * 1e6) / 1e6;

export function LocationPicker({
  open,
  onOpenChange,
  value,
  onChoose,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: ChosenLocation | null;
  onChoose: (location: ChosenLocation) => void;
}) {
  const [pin, setPin] = useState<Pin | null>(null);
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Place[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [paste, setPaste] = useState("");
  const [pasting, setPasting] = useState(false);
  const [pasteError, setPasteError] = useState("");
  const [lookingUp, setLookingUp] = useState(false);
  const lookup = useRef(0);
  const branch = useBranch().branch.id;

  // Start from the step's current place each time the picker opens (not on every render of the
  // step, which would undo what's being typed here).
  const current = useRef(value);
  current.current = value;
  useEffect(() => {
    if (!open) return;
    const v = current.current;
    setPin(v ? { latitude: v.latitude, longitude: v.longitude } : null);
    setName(v?.name ?? "");
    setAddress(v?.address ?? "");
    setQuery("");
    setResults(null);
    setPaste("");
    setPasteError("");
  }, [open]);

  // Search as they type, after a pause.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 3) {
      setResults(null);
      return;
    }
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const { places } = await api<{ places: Place[] }>(
          inBranch(`/automations/places?q=${encodeURIComponent(q)}`, branch),
        );
        setResults(places);
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 450);
    return () => clearTimeout(t);
  }, [query, branch]);

  const choosePlace = (p: Place) => {
    lookup.current++;
    setPin({ latitude: p.latitude, longitude: p.longitude });
    setName(p.name);
    setAddress(p.address);
    setResults(null);
    setQuery("");
  };

  /** The pin moved on the map: fill in the address there (the name is theirs to write). */
  const movePin = async (p: Pin) => {
    setPin(p);
    const mine = ++lookup.current;
    setLookingUp(true);
    try {
      const { place } = await api<{ place: Place | null }>(
        inBranch(`/automations/places/reverse?lat=${p.latitude}&lon=${p.longitude}`, branch),
      );
      if (mine !== lookup.current) return;
      if (place)
        setAddress(
          place.name && !place.address.startsWith(place.name)
            ? `${place.name}, ${place.address}`
            : place.address,
        );
    } catch {
      // The pin is what counts; the address can be typed.
    } finally {
      if (mine === lookup.current) setLookingUp(false);
    }
  };

  const applyPasted = async () => {
    if (!paste.trim()) return;
    setPasting(true);
    setPasteError("");
    try {
      const { pin: found } = await api<{ pin: { latitude: number; longitude: number; name: string } }>(
        inBranch("/automations/map-link", branch),
        { method: "POST", json: { text: paste } },
      );
      lookup.current++;
      setPin({ latitude: found.latitude, longitude: found.longitude });
      if (found.name) setName(found.name);
      setPaste("");
      void movePin({ latitude: found.latitude, longitude: found.longitude });
    } catch (err) {
      setPasteError(
        err instanceof ApiError && err.status === 422
          ? "No place found in that. Paste a Google Maps link to a place, or coordinates like 25.08, 55.14."
          : "Couldn't read that link. Try again, or drop the pin on the map.",
      );
    } finally {
      setPasting(false);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Choose the location"
      description="Search for a place, paste a Google Maps link, or click the map to drop the pin."
      size="xl"
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!pin}
            onClick={() => {
              if (!pin) return;
              onChoose({
                latitude: round(pin.latitude),
                longitude: round(pin.longitude),
                name: name.trim().slice(0, 100),
                address: address.trim().slice(0, 300),
              });
              onOpenChange(false);
            }}
          >
            Use this location
          </Button>
        </>
      }
    >
      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_280px]">
        <div className="flex min-w-0 flex-col gap-3">
          <div className="relative">
            <TextInput
              aria-label="Search for a place"
              placeholder="Search for a place or address"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query.trim().length >= 3 ? (
              <div className="absolute inset-x-0 top-full z-[1100] mt-1 max-h-64 overflow-y-auto rounded-md border bg-popover p-1 shadow-md">
                {searching && !results ? (
                  <p className="px-3 py-2 text-sm text-muted-foreground">Searching…</p>
                ) : results?.length ? (
                  results.map((p) => (
                    <button
                      key={`${p.latitude},${p.longitude}`}
                      type="button"
                      className="flex w-full flex-col items-start rounded-sm px-3 py-2 text-left hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
                      onClick={() => choosePlace(p)}
                    >
                      <span className="text-sm font-medium">{p.name}</span>
                      <span className="line-clamp-1 text-xs text-muted-foreground">{p.address}</span>
                    </button>
                  ))
                ) : results ? (
                  <p className="px-3 py-2 text-sm text-muted-foreground">No places found.</p>
                ) : null}
              </div>
            ) : null}
          </div>
          <div className="h-[340px] overflow-hidden rounded-md border md:h-[420px]">
            {open ? (
              <LocationMap pin={pin} onPick={(p) => void movePin(p)} className="h-full w-full" />
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">Drag the pin to fine-tune it.</p>
        </div>
        <div className="flex flex-col gap-4">
          <Field
            label="Paste a link or coordinates"
            hint={pasteError || "A Google Maps link, or 25.08, 55.14."}
          >
            {(control) => (
              <div className="flex gap-2">
                <TextInput
                  {...control}
                  value={paste}
                  placeholder="https://maps.app.goo.gl/…"
                  onChange={(e) => setPaste(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void applyPasted();
                    }
                  }}
                />
                <Button
                  variant="outline"
                  disabled={pasting || !paste.trim()}
                  onClick={() => void applyPasted()}
                >
                  {pasting ? <Icon name="loading" className="animate-spin" /> : "Use"}
                </Button>
              </div>
            )}
          </Field>
          <Field label="Name" optional hint="Shown in bold on the pin, like your branch's name.">
            <TextInput value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Address" optional hint={lookingUp ? "Looking up the address…" : undefined}>
            <TextInput value={address} maxLength={300} onChange={(e) => setAddress(e.target.value)} />
          </Field>
          <p className="text-xs text-muted-foreground tabular-nums">
            {pin ? `${round(pin.latitude)}, ${round(pin.longitude)}` : "No pin yet"}
          </p>
        </div>
      </div>
    </Modal>
  );
}
