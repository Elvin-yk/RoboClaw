import { useMemo, useState } from 'react'
import {
  memberLabel,
  type MemberInputResolver,
} from '@/domains/collection/lib/memberInput'
import { type OrganizationMember } from '@/shared/api/evoClient'
import { cn } from '@/shared/lib/cn'

const MAX_SUGGESTIONS = 6

interface OrganizationMemberPickerProps {
  value: string
  resolver: MemberInputResolver
  onChange: (value: string) => void
  disabled?: boolean
  inputClassName?: string
  placeholder?: string
  required?: boolean
}

export default function OrganizationMemberPicker({
  value,
  resolver,
  onChange,
  disabled = false,
  inputClassName,
  placeholder = '输入手机号或昵称',
  required = false,
}: OrganizationMemberPickerProps) {
  const [focused, setFocused] = useState(false)
  const suggestions = useMemo(
    () => resolver.suggestions(value, MAX_SUGGESTIONS),
    [resolver, value],
  )
  const showSuggestions = focused && value.trim().length > 0 && suggestions.length > 0

  function chooseMember(member: OrganizationMember) {
    onChange(member.phone)
    setFocused(false)
  }

  return (
    <div className="collection-member-picker">
      <input
        className={cn('collection-input', inputClassName)}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder={placeholder}
        required={required}
        disabled={disabled}
        aria-autocomplete="list"
      />
      {showSuggestions && (
        <div className="collection-member-picker__menu" role="listbox">
          {suggestions.map((member) => (
            <button
              key={member.id}
              className="collection-member-picker__option"
              type="button"
              role="option"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => chooseMember(member)}
            >
              <span>
                <strong>{memberLabel(member)}</strong>
                {member.nickname && <small>{member.phone}</small>}
              </span>
              <i>{member.role_code}</i>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
